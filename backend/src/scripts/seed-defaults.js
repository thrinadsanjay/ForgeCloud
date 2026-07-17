import "dotenv/config";
import { connectDb } from "../db/client.js";
import { syncSchema } from "../db/schemaSync.js";
import { prisma } from "../db/client.js";

const PACKAGE_CATALOG = [
  "ansible", "aqt", "awscli", "curl", "docker", "docker-compose", "dotnet-sdk",
  "git", "go", "grafana", "helm", "htop", "java", "jq", "kubectl", "maven",
  "mongodb", "mysql", "nginx", "nodejs", "openjdk", "php", "postgres", "postman",
  "prometheus", "python", "rabbitmq", "redis", "terraform", "tmux", "vim", "yarn",
];

const DEFAULT_AGENTS = [
  { id: "defender", name: "Microsoft Defender for Endpoint", pkg: "mdatp" },
  { id: "omi", name: "OMI Client", pkg: "omi" },
  { id: "guardicore", name: "Guardicore Agent", pkg: "guardicore-agent" },
];

const TEMPLATE_DEFAULTS = {
  MEAN: [
    { letter: "M", name: "MongoDB" },
    { letter: "E", name: "Express.js" },
    { letter: "A", name: "Angular" },
    { letter: "N", name: "Node.js" },
  ],
  MERN: [
    { letter: "M", name: "MongoDB" },
    { letter: "E", name: "Express.js" },
    { letter: "R", name: "React" },
    { letter: "N", name: "Node.js" },
  ],
  LAMP: [
    { letter: "L", name: "Linux" },
    { letter: "A", name: "Apache" },
    { letter: "M", name: "MySQL" },
    { letter: "P", name: "PHP" },
  ],
};

const INSTANCE_SIZES = [
  { key: "micro", label: "Micro", cpu: 1, memoryGB: 1, sortOrder: 0 },
  { key: "mini", label: "Mini", cpu: 1, memoryGB: 2, sortOrder: 1 },
  { key: "small", label: "Small", cpu: 2, memoryGB: 4, sortOrder: 2 },
  { key: "medium", label: "Medium", cpu: 4, memoryGB: 8, sortOrder: 3 },
  { key: "large", label: "Large", cpu: 8, memoryGB: 16, sortOrder: 4 },
  { key: "xl", label: "Extra large", cpu: 16, memoryGB: 32, sortOrder: 5 },
];

const VM_STEP_DEFS = [
  { key: "submitted", label: "Request submitted", active: "Receiving your new-server request…", done: "New server request submitted", eta: 2, group: "request" },
  { key: "approval", label: "Approvals", active: "Checking approval requirements…", done: "Standard request — auto-approved", eta: 2, group: "request" },
  { key: "approved", label: "Approved", active: "Locking in the approval…", done: "Request approved — kicking off the build", eta: 1, group: "request" },
  { key: "provision_vm", label: "Provisioning the VM", active: "Carving out your virtual machine on the cluster…", done: "Virtual machine provisioned", eta: 45, group: "build" },
  { key: "deploy_os", label: "Deploying the OS", active: "Laying down the golden OS image…", done: "Operating system deployed", eta: 40, group: "build" },
  { key: "allocate_resources", label: "Allocating resources", active: "Dialing in your CPU, memory and storage…", done: "Requested resources allocated", eta: 15, group: "build" },
  { key: "assign_ip", label: "Assigning IP address", active: "Wiring your machine into the network…", done: "Network attached (DHCP)", eta: 12, group: "build" },
  { key: "power_on", label: "Powering on", active: "Powering on your virtual machine…", done: "Powered on", eta: 10, group: "boot" },
  { key: "system_startup", label: "System startup", active: "Waiting for the system to come alive…", done: "System is online", eta: 90, group: "boot" },
  { key: "initial_setup", label: "Initial setup", active: "Running first-boot initialization and creating your account…", done: "Initial setup complete", eta: 25, group: "config" },
  { key: "default_packages", label: "Default packages", active: "Installing default packages via cloud-init…", done: "Default packages installed", eta: 45, group: "config" },
  { key: "requested_packages", label: "Requested software", active: "Installing your requested software…", done: "Requested software installed", eta: 35, group: "config" },
  { key: "validate", label: "Validation", active: "Running final health checks on your server…", done: "Server validated end-to-end", eta: 15, group: "config" },
  { key: "summarize", label: "Summary", active: "Wrapping up and preparing your summary…", done: "All done — your server is ready", eta: 3, group: "done" },
];

export async function seedDefaults() {
  // Retired internal workflow template — remove if it was seeded previously.
  await prisma.workflowStep.deleteMany({ where: { workflowId: "internal-linux" } });
  await prisma.workflowTemplate.deleteMany({ where: { id: "internal-linux" } });

  const pkgCount = await prisma.package.count();
  if (pkgCount === 0) {
    await prisma.package.createMany({
      data: PACKAGE_CATALOG.map((id, i) => ({
        id,
        name: id,
        enabled: true,
        sortOrder: i,
      })),
    });
    console.log(`[seed] ${PACKAGE_CATALOG.length} packages`);
  }

  const baselineCount = await prisma.securityBaselineAgent.count();
  if (baselineCount > 0) {
    const legacy = await prisma.securityBaselineAgent.findMany();
    for (const b of legacy) {
      await prisma.package.upsert({
        where: { id: b.id },
        create: {
          id: b.id,
          name: b.name,
          installPkg: b.pkg,
          isDefault: true,
          enabled: b.enabled,
          sortOrder: b.sortOrder,
        },
        update: { name: b.name, installPkg: b.pkg, isDefault: true, enabled: b.enabled },
      });
    }
    await prisma.securityBaselineAgent.deleteMany({});
    console.log(`[seed] migrated ${legacy.length} baseline agents → default packages`);
  }

  for (const [i, a] of DEFAULT_AGENTS.entries()) {
    await prisma.package.upsert({
      where: { id: a.id },
      create: {
        id: a.id,
        name: a.name,
        installPkg: a.pkg,
        isDefault: true,
        enabled: true,
        sortOrder: 1000 + i,
      },
      update: { name: a.name, installPkg: a.pkg, isDefault: true },
    });
  }
  console.log(`[seed] ${DEFAULT_AGENTS.length} default packages ensured`);

  const inrRates = { perCpu: 1800, perGbRam: 85, perGbStorage: 12 };
  await prisma.costRate.upsert({
    where: { id: "default" },
    create: { id: "default", ...inrRates },
    update: inrRates,
  });
  console.log("[seed] cost rates (INR)");

  const defCount = await prisma.templateDefault.count();
  if (defCount === 0) {
    await prisma.templateDefault.createMany({
      data: Object.entries(TEMPLATE_DEFAULTS).map(([presetKey, items]) => ({ presetKey, items })),
    });
    console.log(`[seed] ${Object.keys(TEMPLATE_DEFAULTS).length} template defaults`);
  }

  const sizeCount = await prisma.instanceSize.count();
  if (sizeCount === 0) {
    await prisma.instanceSize.createMany({
      data: INSTANCE_SIZES.map((s) => ({ ...s, enabled: true })),
    });
    console.log(`[seed] ${INSTANCE_SIZES.length} instance sizes`);
  }

  const stepCount = await prisma.deploymentStepDef.count();
  if (stepCount === 0) {
    await prisma.deploymentStepDef.createMany({ data: VM_STEP_DEFS });
    console.log(`[seed] ${VM_STEP_DEFS.length} deployment step definitions`);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  await connectDb();
  syncSchema();
  await seedDefaults();
  console.log("[seed] done");
  process.exit(0);
}
