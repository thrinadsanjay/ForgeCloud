import { updateJob, assertJobNotCancelled } from "./jobStore.js";
import {
  applyOneDocument,
  parseYamlDocs,
  deleteWorkloadStack,
  deletePod,
  deleteNamespace,
  forceFinalizeNamespace,
  waitForDeploymentsReady,
  ingressUrlsFromDocs,
} from "./k3sService.js";

function cloneSteps(steps) {
  return steps.map((s) => ({ ...s }));
}

function setStep(steps, key, patch) {
  return steps.map((s) => (s.key === key ? { ...s, ...patch } : s));
}

function skipPending(steps) {
  return steps.map((s) => (s.state === "pending" ? { ...s, state: "skipped" } : s));
}

/**
 * Async K8s apply tracked as a Forge job (shows in the deployment monitor).
 */
export async function runK8sApplyJob(jobId, { namespace, yamlText } = {}) {
  let steps = [
    {
      key: "parse",
      label: "Parse manifest",
      state: "pending",
      active: "Parsing YAML…",
      done: "Manifest parsed",
    },
  ];

  try {
    updateJob(jobId, {
      status: "provisioning",
      message: "Parsing YAML…",
      steps: cloneSteps(setStep(steps, "parse", { state: "active" })),
    });
    assertJobNotCancelled(jobId);

    const docs = await parseYamlDocs(String(yamlText || ""));
    if (!docs.length) throw new Error("No YAML documents found");

    steps = [
      {
        key: "parse",
        label: "Parse manifest",
        state: "done",
        done: `Parsed ${docs.length} object${docs.length === 1 ? "" : "s"}`,
        active: "Parsing YAML…",
      },
      ...docs.map((d, i) => {
        const kind = String(d.kind || "Object");
        const name = String(d.metadata?.name || "?");
        return {
          key: `doc-${i}-${kind}-${name}`,
          label: `Apply ${kind}/${name}`,
          state: "pending",
          active: `Applying ${kind}/${name}…`,
          done: `${kind}/${name} configured`,
          via: "Kubernetes API",
        };
      }),
    ];
    updateJob(jobId, {
      status: "provisioning",
      message: `Applying ${docs.length} object(s) to ${namespace}…`,
      steps: cloneSteps(steps),
    });

    const applied = [];
    for (let i = 0; i < docs.length; i++) {
      assertJobNotCancelled(jobId);
      const doc = docs[i];
      if (!doc || typeof doc !== "object") continue;
      const kind = String(doc.kind || "").trim();
      const apiVersion = String(doc.apiVersion || "v1").trim();
      if (!kind) throw new Error("YAML document missing kind");
      if (!doc.metadata || typeof doc.metadata !== "object") doc.metadata = {};
      const name = String(doc.metadata.name || "").trim();
      if (!name) throw new Error(`${kind} is missing metadata.name`);
      if (kind !== "Namespace") doc.metadata.namespace = namespace;

      const stepKey = steps[i + 1].key;
      steps = setStep(steps, stepKey, { state: "active" });
      updateJob(jobId, {
        status: "provisioning",
        message: `Applying ${kind}/${name}…`,
        steps: cloneSteps(steps),
      });

      try {
        const result = await applyOneDocument({ apiVersion, kind, namespace, name, doc });
        applied.push(result);
        steps = setStep(steps, stepKey, {
          state: "done",
          done: `${kind}/${name} ${result.action}`,
        });
        updateJob(jobId, {
          message: `${kind}/${name} ${result.action}`,
          steps: cloneSteps(steps),
        });
      } catch (err) {
        steps = skipPending(setStep(steps, stepKey, {
          state: "failed",
          active: err.message,
        }));
        updateJob(jobId, {
          status: "failed",
          message: `Failed applying ${kind}/${name}`,
          error: err.message,
          errorUserMessage: err.message,
          steps: cloneSteps(steps),
          resources: [{
            type: "k8s",
            namespace,
            hostname: `${namespace}/${name}`,
            sshReady: false,
          }],
        });
        return;
      }
    }

    const deploymentNames = applied
      .filter((a) => String(a.kind || "").toLowerCase() === "deployment")
      .map((a) => a.name)
      .filter(Boolean);
    // Also pick Deployments from parsed docs in case apply result omits kind casing.
    for (const d of docs) {
      if (String(d.kind || "") === "Deployment" && d.metadata?.name) {
        if (!deploymentNames.includes(d.metadata.name)) deploymentNames.push(d.metadata.name);
      }
    }

    const ingressUrls = ingressUrlsFromDocs(docs);
    const primaryName = deploymentNames[0] || applied.find((a) => a.kind === "Deployment")?.name || applied[0]?.name || "stack";

    if (deploymentNames.length) {
      const waitKey = "wait-ready";
      steps = [
        ...steps,
        {
          key: waitKey,
          label: "Wait for pods Ready",
          state: "active",
          active: `Waiting for ${deploymentNames.map((n) => `Deployment/${n}`).join(", ")}…`,
          done: "Pods Ready",
          via: "Kubernetes API",
        },
      ];
      updateJob(jobId, {
        status: "provisioning",
        message: `Waiting for pods to become Ready in ${namespace}…`,
        steps: cloneSteps(steps),
      });

      try {
        assertJobNotCancelled(jobId);
        await waitForDeploymentsReady({
          namespace,
          names: deploymentNames,
          timeoutMs: 300_000,
          intervalMs: 4_000,
          fatalGraceMs: 45_000,
          onTick: ({ detail }) => {
            assertJobNotCancelled(jobId);
            steps = setStep(steps, waitKey, {
              state: "active",
              active: detail || "Waiting for pods…",
            });
            updateJob(jobId, {
              status: "provisioning",
              message: detail || `Waiting for pods in ${namespace}…`,
              steps: cloneSteps(steps),
            });
          },
        });
        steps = setStep(steps, waitKey, {
          state: "done",
          done: `${deploymentNames.length} deployment(s) Ready`,
        });
      } catch (err) {
        if (err.cancelled) return;
        const userMsg = err.message || "Pods did not become Ready";
        steps = skipPending(setStep(steps, waitKey, {
          state: "failed",
          active: userMsg,
        }));
        updateJob(jobId, {
          status: "failed",
          message: "Workload not Ready",
          error: userMsg,
          errorUserMessage: userMsg,
          errorDetail: err.detail || null,
          steps: cloneSteps(steps),
          resources: [{
            type: "k8s",
            namespace,
            hostname: `${namespace}/${primaryName}`,
            urls: ingressUrls,
            sshReady: false,
          }],
        });
        return;
      }
    }

    assertJobNotCancelled(jobId);
    const urlHint = ingressUrls.length
      ? ` Routes: ${ingressUrls.join(", ")} — DNS/hosts must resolve those names to your Traefik entrypoint (node IP / LB).`
      : "";
    updateJob(jobId, {
      status: "ready",
      message: deploymentNames.length
        ? `Ready: ${deploymentNames.join(", ")} in ${namespace}.${urlHint}`
        : `Applied ${applied.length} object(s) in ${namespace}.${urlHint}`,
      steps: cloneSteps(steps),
      resources: [{
        type: "k8s",
        namespace,
        hostname: `${namespace}/${primaryName}`,
        urls: ingressUrls,
        ip: ingressUrls[0] || null,
        sshReady: true,
      }],
    });
  } catch (err) {
    if (err.cancelled) return;
    steps = skipPending(steps.map((s) => (s.state === "active" ? { ...s, state: "failed", active: err.message } : s)));
    updateJob(jobId, {
      status: "failed",
      message: "Kubernetes apply failed",
      error: err.message,
      errorUserMessage: err.message,
      steps: cloneSteps(steps),
    });
  }
}

/**
 * Async K8s workload teardown tracked in the deployment monitor.
 * target: { kind: "deployment"|"pod"|"namespace", name }
 */
export async function runK8sDeleteJob(jobId, { namespace, target, force = false } = {}) {
  const kind = String(target?.kind || "deployment");
  const name = String(target?.name || "").trim();
  const mode = force ? "Force terminate" : "Terminate";

  let steps = [];
  if (kind === "namespace") {
    steps = [
      {
        key: "delete-ns",
        label: `${mode} namespace`,
        state: "pending",
        active: `${mode} ${name}…`,
        done: `Namespace ${name} removed`,
        via: "Kubernetes API",
      },
    ];
  } else if (kind === "pod") {
    steps = [
      {
        key: "delete-pod",
        label: `${mode} pod`,
        state: "pending",
        active: `${mode} pod ${name}…`,
        done: `Pod ${name} removed`,
        via: "Kubernetes API",
      },
    ];
  } else {
    steps = [
      {
        key: "scale",
        label: "Scale to zero",
        state: "pending",
        active: "Scaling deployment to 0…",
        done: "Replicas set to 0",
        via: "Kubernetes API",
      },
      {
        key: "delete-dep",
        label: `${mode} deployment`,
        state: "pending",
        active: `Deleting Deployment/${name}…`,
        done: `Deployment/${name} deleted`,
        via: "Kubernetes API",
      },
      {
        key: "clean-pods",
        label: "Remove leftover pods",
        state: "pending",
        active: "Cleaning pods…",
        done: "Pods cleaned",
        via: "Kubernetes API",
      },
      {
        key: "companions",
        label: "Remove Service / Ingress / PVC",
        state: "pending",
        active: "Deleting companion objects…",
        done: "Companions removed",
        via: "Kubernetes API",
      },
    ];
  }

  const bump = (key, patch, message) => {
    steps = setStep(steps, key, patch);
    updateJob(jobId, {
      status: "provisioning",
      message,
      steps: cloneSteps(steps),
    });
  };

  try {
    updateJob(jobId, {
      status: "provisioning",
      message: `${mode} ${kind}/${name} in ${namespace}…`,
      steps: cloneSteps(steps),
    });
    assertJobNotCancelled(jobId);

    if (kind === "namespace") {
      bump("delete-ns", { state: "active" }, `${mode} namespace ${name}…`);
      if (force) {
        try { await deleteNamespace(name); } catch { /* may already be terminating */ }
        await forceFinalizeNamespace(name);
      } else {
        await deleteNamespace(name);
      }
      bump("delete-ns", { state: "done" }, `Namespace ${name} removed`);
    } else if (kind === "pod") {
      bump("delete-pod", { state: "active" }, `${mode} pod ${name}…`);
      await deletePod(namespace, name, { force: !!force });
      bump("delete-pod", { state: "done" }, `Pod ${name} removed`);
    } else {
      const order = ["scale", "delete-dep", "clean-pods", "companions"];
      const markDoneThrough = (phase) => {
        for (const key of order) {
          const step = steps.find((s) => s.key === key);
          if (!step) continue;
          if (step.key === phase) {
            bump(key, { state: "done" }, step.done || step.label);
            break;
          }
          if (step.state === "pending" || step.state === "active") {
            bump(key, { state: "done" }, step.done || step.label);
          }
        }
      };

      const result = await deleteWorkloadStack(namespace, name, {
        force: !!force,
        onProgress: (phase) => {
          assertJobNotCancelled(jobId);
          // Complete prior phases, activate current.
          for (const key of order) {
            if (key === phase) break;
            const step = steps.find((s) => s.key === key);
            if (step && step.state !== "done") {
              steps = setStep(steps, key, { state: "done" });
            }
          }
          bump(phase, { state: "active" }, steps.find((s) => s.key === phase)?.active || phase);
        },
      });
      markDoneThrough("companions");
      steps = setStep(steps, "clean-pods", {
        state: "done",
        done: `Removed ${result?.cleaned?.pods || 0} pod(s)`,
      });
    }

    assertJobNotCancelled(jobId);
    updateJob(jobId, {
      status: "ready",
      message: `${mode} completed for ${kind}/${name}.`,
      steps: cloneSteps(steps),
      resources: [{
        type: "k8s",
        namespace: kind === "namespace" ? name : namespace,
        hostname: kind === "namespace" ? name : `${namespace}/${name}`,
        sshReady: true,
      }],
    });
  } catch (err) {
    if (err.cancelled) return;
    steps = skipPending(steps.map((s) => (s.state === "active" ? { ...s, state: "failed", active: err.message } : s)));
    updateJob(jobId, {
      status: "failed",
      message: `${mode} failed for ${kind}/${name}`,
      error: err.message,
      steps: cloneSteps(steps),
    });
  }
}
