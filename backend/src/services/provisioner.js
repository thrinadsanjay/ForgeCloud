import * as pve from "./proxmoxService.js";
import { updateJob, peekJob, assertJobNotCancelled } from "./jobStore.js";
import { getTemplateMappings } from "./mappingStore.js";
import { setOwnerIp, removeOwner } from "./ownershipStore.js";
import { removeExpiry } from "./expiryStore.js";
import { groupsForUser } from "./groupStore.js";
import { ownerTags } from "./tags.js";
import { waitForPort } from "./portProbe.js";
import { generatePassword } from "./passwordGen.js";
import { runSsh } from "./sshRunner.js";
import { hostnameSetupCommand, userSetupCommands, packageInstallCommand, aiTroubleshoot } from "./aiOps.js";
import { executeStep, isSystemConfigured } from "./internalProvisioningApis.js";
import { findContainerTemplate, findStack, findInternalTemplate, packageById, resolveInstallPkg, getDefaultPackages } from "./catalogService.js";
import { createStepTracker } from "./deploymentSteps.js";
import {
  buildUserData,
  partitionPackages,
  snippetFilename,
  summarizeCloudInitPackages,
} from "./cloudInitService.js";
import { onStepChange } from "./snowLifecycle.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function destroyOrphanGuest({ vmid, type = "vm" }) {
  if (!Number.isFinite(Number(vmid))) return;
  try {
    if (type === "container") await pve.deleteContainer({ vmid: Number(vmid) });
    else await pve.deleteVm({ vmid: Number(vmid) });
    removeOwner(Number(vmid));
    removeExpiry(Number(vmid));
  } catch (err) {
    console.warn(`[provision] orphan cleanup ${vmid} failed: ${err.message}`);
  }
}

// Run a list of {name, cmd} over SSH as root, with a one-shot AI-assisted retry
// on failure. Returns per-command results (best-effort — never throws).
async function runCommands(cmds, sshOpts, { osName, packageManager } = {}) {
  const results = [];
  for (const c of cmds) {
    if (!c || !c.cmd) continue;
    let res = await runSsh({ ...sshOpts, command: c.cmd }).catch((e) => ({ code: 1, stdout: "", stderr: e.message }));
    if (res.code !== 0) {
      const fix = await aiTroubleshoot({ command: c.cmd, stderr: res.stderr, osName, packageManager }).catch(() => null);
      if (fix?.fix) {
        await runSsh({ ...sshOpts, command: fix.fix }).catch(() => {});
        res = await runSsh({ ...sshOpts, command: c.cmd }).catch((e) => ({ code: 1, stdout: "", stderr: e.message }));
      }
    }
    results.push({ name: c.name, ok: res.code === 0, stderr: res.code === 0 ? "" : (res.stderr || "").slice(0, 300) });
  }
  return results;
}

// Resolve a VM template id to its Proxmox VMID + mapping. Mapping-derived ids
// look like "tpl-<vmid>"; anything else (e.g. stack member ids) falls back to
// the static catalog.
function resolveVmTemplate(templateId) {
  if (typeof templateId === "string" && /^tpl-\d+$/.test(templateId)) {
    const vmid = Number(templateId.slice(4));
    const m = getTemplateMappings()[String(vmid)];
    if (m) return { id: templateId, vmid, name: m.osName || `template-${vmid}`, mapping: m };
  }
  return null;
}

// Poll the qemu-guest-agent until it reports a DHCP-leased IPv4 (or times out).
async function discoverVmIp(vmid, { timeoutMs = 600000, intervalMs = 10000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ip = await pve.getGuestAgentIp({ vmid }).catch(() => null);
    if (ip) return ip;
    if (onTick) onTick();
    await sleep(intervalMs);
  }
  return null;
}

async function discoverContainerIp(vmid, { timeoutMs = 180000, intervalMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ip = await pve.getContainerIp({ vmid }).catch(() => null);
    if (ip) return ip;
    await sleep(intervalMs);
  }
  return null;
}

// Clone + boot a single VM on DHCP (used by stacks). IP is discovered by the
// caller after boot via the guest agent.
async function provisionSingleVm({ templateId, hostname, cpu, memoryGB, additionalDiskGB = 0, packages = [] }) {
  const template = resolveVmTemplate(templateId);
  if (!template) throw new Error(`Unknown VM template: ${templateId}`);

  const newVmid = await pve.getNextVmid();
  await pve.cloneVm({ templateVmid: template.vmid, newVmid, hostname });

  // OS disk keeps the template's size; only allocate CPU/RAM here.
  await pve.configureVm({ vmid: newVmid, cores: cpu, memory: memoryGB * 1024 });
  if (Number(additionalDiskGB) > 0) {
    await pve.attachDisk({ vmid: newVmid, sizeGB: Number(additionalDiskGB) });
  }
  await pve.setCloudInit({ vmid: newVmid, hostname }); // no staticIp => ip=dhcp
  await pve.startVm({ vmid: newVmid });

  return { vmid: newVmid, hostname, type: "vm", templateId, ip: null, requestedPackages: packages };
}

async function provisionContainer({ templateId, hostname, cpu, memoryGB, packages = [] }) {
  const template = findContainerTemplate(templateId);
  if (!template) throw new Error(`Unknown container template: ${templateId}`);

  const newVmid = await pve.getNextVmid();
  await pve.cloneContainer({ templateVmid: template.vmid, newVmid, hostname });

  // No staticIp => keep the template's DHCP networking.
  await pve.configureContainer({ vmid: newVmid, cores: cpu, memory: memoryGB * 1024 });
  await pve.startContainer({ vmid: newVmid });

  return { vmid: newVmid, hostname, type: "container", templateId, ip: null, requestedPackages: packages };
}

// Full VM deployment pipeline, driven by a structured step tracker so the
// deployment monitor shows each step with an impactful statement, an ETA, and
// the time it actually took. Post-boot configuration always SSHes in as the
// template's root account (from Mappings) — never the end-user account.
export async function runVmJob(jobId, payload) {
  const {
    templateId, hostname, cpu, memoryGB, additionalDiskGB = 0,
    packages = [], username, sudoAccess = false, environment,
  } = payload;

  const tracker = createStepTracker({
    templateKey: templateId,
    emit: (p) => updateJob(jobId, p),
    onStepEvent: (ev) => {
      const requestId = payload.requestId;
      if (!requestId) return;
      onStepChange({ requestId, jobId, ...ev }).catch((err) => {
        console.warn(`[snow] step note failed: ${err.message}`);
      });
    },
  });
  let newVmid = null;
  let snippetName = null;
  let cloudInitApplied = false;
  const generatedPassword = username ? generatePassword() : null;

  try {
    const tpl = resolveVmTemplate(templateId);
    if (!tpl) throw new Error(`Unknown VM template: ${templateId}`);
    const m = tpl.mapping || {};
    const rootUser = m.credUser || "root";
    const rootPass = m.credPassword || process.env.VM_SSH_PASSWORD || "";
    const sshPort = m.port || 22;
    const cloudInitFile = m.cloudInitFile || null;
    const packageManager = m.packageManager || "apt";

    const defaultCatalog = getDefaultPackages();
    const defaultIds = new Set(defaultCatalog.map((p) => p.id));
    const optionalIds = (packages || []).filter((id) => !defaultIds.has(id));
    const allPackageIds = [...defaultCatalog.map((p) => p.id), ...optionalIds];
    const { cloudInit, sshOnly } = partitionPackages(allPackageIds);
    const defaultCloudIds = new Set(defaultCatalog.filter((p) => !p.installCmd).map((p) => p.id));
    const optionalCloudIds = optionalIds.filter((id) => !packageById(id)?.installCmd);

    // --- Request / approval steps (already settled by the time we run) ---
    tracker.quickDone("submitted");
    tracker.quickDone("approval", {
      done: payload.autoApproved === false
        ? `Approved by ${payload.approvedBy || "an administrator"}`
        : "Standard request — auto-approved",
    });
    tracker.quickDone("approved");

    assertJobNotCancelled(jobId);

    // --- Provision the VM (clone) ---
    tracker.start("provision_vm");
    newVmid = await pve.getNextVmid();
    assertJobNotCancelled(jobId);
    await pve.cloneVm({ templateVmid: tpl.vmid, newVmid, hostname });
    assertJobNotCancelled(jobId);
    // Register early so Stop can destroy this guest before later steps finish.
    updateJob(jobId, {
      resources: [{ vmid: newVmid, hostname, type: "vm", ip: null, environment, sshReady: false }],
    });
    tracker.done("provision_vm", { done: `Virtual machine #${newVmid} provisioned` });

    // --- Deploy the OS (disk copy finishes when the clone lock clears) ---
    tracker.start("deploy_os");
    await pve.waitForUnlock({ vmid: newVmid, onTick: () => {} });
    await sleep(4000);
    assertJobNotCancelled(jobId);
    tracker.done("deploy_os", { done: `${tpl.name} image deployed` });

    // --- Allocate resources (CPU / RAM; OS disk size comes from the template) ---
    tracker.start("allocate_resources");
    await pve.editVm({ vmid: newVmid, cores: cpu, memory: Number(memoryGB) * 1024 });
    const osDisk = await pve.getDiskSizeGB({ vmid: newVmid, disk: "scsi0" }).catch(() => null);
    // Attach an extra data disk when the user opted in (primary stays template-sized).
    const extraDisk = Number(additionalDiskGB) || 0;
    let extraDiskMsg = "";
    if (extraDisk > 0) {
      await pve.attachDisk({ vmid: newVmid, sizeGB: extraDisk });
      extraDiskMsg = ` · +${extraDisk} GB data disk`;
    }
    const osDiskMsg = osDisk ? ` · ${osDisk} GB OS disk` : "";
    assertJobNotCancelled(jobId);
    tracker.done("allocate_resources", { done: `Allocated ${cpu} vCPU · ${memoryGB} GB RAM${osDiskMsg}${extraDiskMsg}` });

    // --- Assign IP / network + cloud-init user-data (packages, hostname, user) ---
    tracker.start("assign_ip");
    await pve.setVmNetwork({ vmid: newVmid, iface: environment });
    snippetName = snippetFilename(newVmid);
    let baseYaml = "";
    if (cloudInitFile) {
      baseYaml = await pve.readSnippetContent({ filename: cloudInitFile }).catch(() => "");
    }
    const userData = buildUserData({
      hostname,
      username,
      password: generatedPassword,
      sudoAccess,
      packageInstallNames: cloudInit.map((p) => p.installName),
      baseYaml,
    });
    await pve.uploadSnippet({ filename: snippetName, content: userData });
    await pve.setCicustom({ vmid: newVmid, file: snippetName });
    cloudInitApplied = true;
    const owner = payload.requestedBy;
    const groups = owner ? groupsForUser(owner) : [];
    await pve.setVmTags({ vmid: newVmid, tags: ownerTags({ username: owner, groups, environment }) });
    assertJobNotCancelled(jobId);
    tracker.done("assign_ip", {
      done: `Network attached · cloud-init queued (${cloudInit.length} package(s))`,
    });

    const resource = { vmid: newVmid, hostname, type: "vm", ip: null, environment, sshReady: false };
    updateJob(jobId, { resources: [resource] });

    // --- Power on ---
    tracker.start("power_on");
    assertJobNotCancelled(jobId);
    await pve.startVm({ vmid: newVmid });
    tracker.done("power_on");

    // --- System startup: wait for DHCP + SSH ---
    tracker.start("system_startup");
    const ip = await discoverVmIp(newVmid, { timeoutMs: 600000, intervalMs: 10000 });
    if (!ip) {
      tracker.stall("Your VM started but never reported a network address (is the guest agent installed?). It was created, but is unreachable.");
      updateJob(jobId, { status: "ready", resources: [{ ...resource, sshReady: false }] });
      return;
    }
    setOwnerIp(newVmid, ip);
    resource.ip = ip;
    const online = await waitForPort({ host: ip, port: sshPort, timeoutMs: 180000, intervalMs: 5000 });
    if (!online) {
      tracker.stall(`Your VM is up at ${ip} but isn't accepting SSH yet. It was created, but is unreachable.`);
      updateJob(jobId, { status: "ready", resources: [{ ...resource, sshReady: false }] });
      return;
    }
    tracker.done("system_startup", { done: `System online at ${ip}` });

    const sshOpts = { host: ip, port: sshPort, username: rootUser, password: rootPass };
    const allStepResults = [];

    // --- Initial setup: wait for cloud-init (hostname, user, packages at first boot) ---
    tracker.start("initial_setup");
    const initCmds = [
      { name: "wait for cloud-init", cmd: "cloud-init status --wait 2>/dev/null || true" },
    ];
    if (!cloudInitApplied) {
      const hostCmd = hostnameSetupCommand({ hostname });
      if (hostCmd) initCmds.push({ name: `set hostname ${hostname}`, cmd: hostCmd });
      initCmds.push(...userSetupCommands({ username, password: generatedPassword, sudo: sudoAccess }));
    }
    allStepResults.push(...await runCommands(initCmds, sshOpts, { osName: tpl.name, packageManager }));
    tracker.done("initial_setup", {
      done: cloudInitApplied
        ? (username
          ? `Cloud-init finished · hostname "${hostname}" · account "${username}" created`
          : `Cloud-init finished · hostname "${hostname}"`)
        : (username
          ? `Hostname set to "${hostname}" · account "${username}" created`
          : `Hostname set to "${hostname}"`),
    });

    // --- Default packages ---
    tracker.start("default_packages");
    const defaultSshOnly = sshOnly.filter((p) => defaultIds.has(p.id));
    if (defaultSshOnly.length) {
      for (const row of defaultSshOnly) {
        allStepResults.push(...await runCommands(
          [{ name: `install ${row.name}`, cmd: row.installCmd }],
          sshOpts,
          { osName: tpl.name, packageManager },
        ));
      }
    }
    if (!cloudInitApplied && defaultCatalog.filter((p) => !p.installCmd).length) {
      const names = defaultCatalog.filter((p) => !p.installCmd).map((p) => resolveInstallPkg(p.id));
      const cmd = packageInstallCommand({ packageManager, packages: names });
      if (cmd) {
        allStepResults.push(...await runCommands(
          [{ name: "install default packages", cmd }],
          sshOpts,
          { osName: tpl.name, packageManager },
        ));
      }
    }
    if (cloudInitApplied && [...defaultCloudIds].some((id) => cloudInit.some((p) => p.id === id))) {
      tracker.done("default_packages", {
        done: `Default packages installed via cloud-init — ${defaultCatalog.filter((p) => defaultCloudIds.has(p.id)).map((p) => p.name).join(", ")}`,
      });
    } else if (defaultCatalog.length) {
      tracker.done("default_packages", {
        done: `Default packages installed — ${defaultCatalog.map((p) => p.name).join(", ")}`,
      });
    } else {
      tracker.skip("default_packages", { done: "No default packages configured" });
    }

    // --- Optional packages selected by the user ---
    const optionalSshOnly = sshOnly.filter((p) => !defaultIds.has(p.id));
    if (optionalSshOnly.length || (!cloudInitApplied && optionalIds.length)) {
      tracker.start("requested_packages");
      for (const row of optionalSshOnly) {
        allStepResults.push(...await runCommands(
          [{ name: `install ${row.name}`, cmd: row.installCmd }],
          sshOpts,
          { osName: tpl.name, packageManager },
        ));
      }
      if (!cloudInitApplied && optionalIds.filter((id) => !packageById(id)?.installCmd).length) {
        const names = optionalIds.filter((id) => !packageById(id)?.installCmd).map((id) => resolveInstallPkg(id));
        const reqCmd = packageInstallCommand({ packageManager, packages: names });
        if (reqCmd) {
          allStepResults.push(...await runCommands(
            [{ name: `install ${optionalIds.join(", ")}`, cmd: reqCmd }],
            sshOpts,
            { osName: tpl.name, packageManager },
          ));
        }
      }
      tracker.done("requested_packages", {
        done: cloudInitApplied && optionalCloudIds.length
          ? `Optional packages installed via cloud-init — ${optionalCloudIds.join(", ")}`
          : `Installed: ${optionalIds.join(", ")}`,
      });
    } else if (cloudInitApplied && optionalCloudIds.length) {
      tracker.start("requested_packages");
      tracker.done("requested_packages", {
        done: `Optional packages installed via cloud-init — ${optionalCloudIds.join(", ")}`,
      });
    } else {
      tracker.skip("requested_packages", { done: "No additional software selected" });
    }

    // --- Validate: confirm each package is present ---
    tracker.start("validate");
    const validations = [];
    for (const pkgId of allPackageIds) {
      const installName = resolveInstallPkg(pkgId);
      const check = await runSsh({
        ...sshOpts,
        command: `command -v ${installName} >/dev/null 2>&1 || rpm -q ${installName} >/dev/null 2>&1 || dpkg -s ${installName} >/dev/null 2>&1 || apk info -e ${installName} >/dev/null 2>&1 && echo OK || echo MISSING`,
      }).catch(() => ({ stdout: "MISSING" }));
      const row = defaultCatalog.find((p) => p.id === pkgId);
      validations.push({
        package: pkgId,
        name: row?.name || pkgId,
        isDefault: defaultIds.has(pkgId),
        present: /OK/.test(check.stdout || ""),
      });
    }
    const pkgsOk = validations.every((v) => v.present);
    tracker.done("validate", {
      done: allPackageIds.length
        ? `Validated ${validations.filter((v) => v.present).length}/${validations.length} package(s)`
        : "Server validated end-to-end",
    });

    // --- Summarize ---
    tracker.start("summarize");
    const allOk = allStepResults.every((r) => r.ok) && pkgsOk;
    tracker.done("summarize", { done: allOk ? "All done — your server is ready 🎉" : "Done — with a few warnings (see summary)" });

    updateJob(jobId, {
      status: "ready",
      message: allOk
        ? `Your VM "${hostname}" is ready to use. Open the summary for login details.`
        : `Your VM "${hostname}" is ready, but some setup steps had issues. Open the summary for details.`,
      resources: [{ ...resource, sshReady: true }],
      result: {
        hostname, vmid: newVmid, ip, environment,
        username: username || null, generatedPassword, sudo: sudoAccess,
        defaultPackages: defaultCatalog.map((p) => p.name),
        packagesViaCloudInit: cloudInitApplied ? summarizeCloudInitPackages(cloudInit) : null,
        validations, steps: allStepResults, allOk,
      },
    });
  } catch (err) {
    if (err.cancelled || peekJob(jobId)?.status === "cancelled") {
      // Cancel API destroys job.resources; clean up a guest that never got registered.
      const listed = (peekJob(jobId)?.resources || []).some((r) => Number(r.vmid) === Number(newVmid));
      if (newVmid && !listed) await destroyOrphanGuest({ vmid: newVmid, type: "vm" });
      return;
    }
    // Prefer user-facing Proxmox messages; keep raw detail for the summary / SNOW.
    const userMsg = err.userMessage || "Something went wrong while creating your VM. Open the summary for details.";
    const detail = err.detail || err.message;
    tracker.fail(userMsg, detail);
    // Enrich after fail (status already failed — SNOW hook already used message/error).
    updateJob(jobId, {
      errorUserMessage: err.userMessage || userMsg,
      errorDetail: err.detail || null,
      proxmoxUpid: err.upid || null,
    });
  } finally {
    if (snippetName) {
      await pve.deleteSnippet({ filename: snippetName }).catch(() => {});
    }
  }
}

// Internal provisioning workflow. Does NOT touch Proxmox — instead it walks the
// fixed workflow defined on the internal template (catalogService),
// calling a real internal system per step over HTTP (ITSM, IPAM, compute,
// storage, firewall, DNS, CMDB). Each step's endpoint is configured in Settings.
// The deployment monitor streams progress as each real call completes.
export async function runInternalJob(jobId, payload) {
  const { templateId, hostname, cpu, memoryGB, diskGB } = payload;

  try {
    const tpl = findInternalTemplate(templateId);
    if (!tpl) throw new Error(`Unknown internal template: ${templateId}`);

    // A structured, per-step tracker the UI renders (grouped by stage) as
    // circles that go green as each step finishes. Kept on the job alongside
    // the streamed log messages.
    const steps = tpl.workflow.map((s) => ({
      key: s.key, stage: s.stage, label: s.label, via: s.via,
      state: "pending", system: null, reference: null, detail: null,
    }));
    const snapshot = () => steps.map((s) => ({ ...s }));

    updateJob(jobId, {
      status: "provisioning",
      message: `Starting the internal provisioning workflow for "${hostname}"…`,
      steps: snapshot(),
      stages: tpl.stages || null,
    });

    // Context accumulates each step's returned fields so later steps can
    // reference earlier results (datacenter, reserved IP, created VMID, …).
    const ctx = { hostname, cpu, memoryGB, diskGB, requestedBy: payload.requestedBy };
    const workflow = [];

    for (let i = 0; i < tpl.workflow.length; i++) {
      assertJobNotCancelled(jobId);
      const step = tpl.workflow[i];

      // A configured system is called for real (its own latency provides the
      // timing); an unconfigured one is simulated — add a short pause so the
      // monitor still streams each step like a real integration.
      const simulated = !isSystemConfigured(step.system);
      steps[i].state = "active";
      // While waiting: "Calling <team/API>…" for the step.
      updateJob(jobId, { status: "provisioning", message: `${step.label} — calling ${step.via}…`, steps: snapshot() });
      if (simulated) await sleep(1500);

      let res;
      try {
        res = await executeStep(step, ctx);
      } catch (err) {
        steps[i] = { ...steps[i], state: "error", detail: err.message };
        updateJob(jobId, { message: `${step.label} — ${step.via} call failed`, steps: snapshot() });
        throw err;
      }
      Object.assign(ctx, res.fields || {}); // carry forward ip, vmid, datacenter, …

      steps[i] = { ...steps[i], state: "done", system: res.system, reference: res.reference, detail: res.detail };
      workflow.push({ step: step.label, stage: step.stage, system: res.system, reference: res.reference, detail: res.detail });
      // Once done: "<team/API> call succeeded" (with the reference it returned).
      updateJob(jobId, { message: `${step.label} — ${step.via} call succeeded${res.reference ? ` · ${res.reference}` : ""}`, steps: snapshot() });
    }

    const resource = {
      vmid: null, // no Proxmox VM — keeps ownership/Resources store clean
      hostname,
      type: "vm",
      ip: ctx.ip || null,
      environment: ctx.vlan || null,
      sshReady: true, // no SSH phase for this workflow; treat as ready
    };

    updateJob(jobId, {
      status: "ready",
      message: `Internal provisioning for "${hostname}" completed. Open the summary for the full workflow.`,
      resources: [resource],
      result: {
        hostname,
        provider: "internal",
        ip: ctx.ip || null,
        fqdn: ctx.fqdn || null,
        cpu,
        memoryGB,
        diskGB,
        workflow,
      },
    });
  } catch (err) {
    if (err.cancelled || peekJob(jobId)?.status === "cancelled") return;
    updateJob(jobId, {
      status: "failed",
      message: "The internal provisioning workflow hit an error. Open the summary for details.",
      error: err.message,
      errorUserMessage: err.message,
      errorDetail: err.stack || err.message,
    });
  }
}

export async function runContainerJob(jobId, { templateId, hostname, cpu, memoryGB, packages = [] }) {
  try {
    assertJobNotCancelled(jobId);
    updateJob(jobId, { status: "provisioning", message: "Creating your container…" });
    const resource = await provisionContainer({ templateId, hostname, cpu, memoryGB, packages });
    assertJobNotCancelled(jobId);

    updateJob(jobId, { status: "booting", message: "Starting your container and waiting for a network address…", resources: [resource] });

    const ip = await discoverContainerIp(resource.vmid);
    if (ip) {
      setOwnerIp(resource.vmid, ip);
      resource.ip = ip;
    }
    const sshUp = ip ? await waitForPort({ host: ip, port: 22 }) : false;
    resource.sshReady = sshUp;
    assertJobNotCancelled(jobId);

    updateJob(jobId, {
      status: "ready",
      message: sshUp
        ? `Your container "${hostname}" is ready to use.`
        : "Your container was created but we couldn't reach it on the network yet.",
      resources: [resource],
    });
  } catch (err) {
    if (err.cancelled || peekJob(jobId)?.status === "cancelled") return;
    updateJob(jobId, {
      status: "failed",
      message: err.userMessage || "Something went wrong while creating your container. Open the summary for details.",
      error: err.detail || err.message,
      errorUserMessage: err.userMessage || null,
      errorDetail: err.detail || null,
      proxmoxUpid: err.upid || null,
    });
  }
}

export async function runStackJob(jobId, { stackId, hostnamePrefix, cpu, memoryGB, additionalDiskGB = 0, packages = [] }) {
  const stack = findStack(stackId);
  if (!stack) {
    updateJob(jobId, { status: "failed", message: "Unknown stack", error: `Stack ${stackId} not found` });
    return;
  }

  const resources = [];
  try {
    assertJobNotCancelled(jobId);
    updateJob(jobId, { status: "provisioning", message: `Creating ${stack.members.length} machine(s) for your stack…` });

    for (const member of stack.members) {
      assertJobNotCancelled(jobId);
      const hostname = `${hostnamePrefix}-${member.hostnameSuffix}`;
      updateJob(jobId, { message: `Creating ${hostname} (${member.role})…` });
      const resource = await provisionSingleVm({
        templateId: member.templateId, hostname, cpu, memoryGB, additionalDiskGB, packages,
      });
      resource.role = member.role;
      resources.push(resource);
      updateJob(jobId, { resources: [...resources] });
    }

    assertJobNotCancelled(jobId);
    updateJob(jobId, { status: "booting", message: "All machines started — waiting for network addresses…", resources: [...resources] });

    for (const resource of resources) {
      assertJobNotCancelled(jobId);
      const ip = await discoverVmIp(resource.vmid, { timeoutMs: 300000, intervalMs: 10000 });
      if (ip) {
        setOwnerIp(resource.vmid, ip);
        resource.ip = ip;
        resource.sshReady = await waitForPort({ host: ip, port: 22 });
      } else {
        resource.sshReady = false;
      }
      updateJob(jobId, { resources: [...resources] });
    }

    updateJob(jobId, { status: "ready", message: `Your stack "${hostnamePrefix}" is ready to use.`, resources });
  } catch (err) {
    if (err.cancelled || peekJob(jobId)?.status === "cancelled") return;
    updateJob(jobId, {
      status: "failed",
      message: err.userMessage || "Something went wrong while creating your stack. Open the summary for details.",
      error: err.detail || err.message,
      errorUserMessage: err.userMessage || null,
      errorDetail: err.detail || err.message || null,
      proxmoxUpid: err.upid || null,
      resources,
    });
  }
}
