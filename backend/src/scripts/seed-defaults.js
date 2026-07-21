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

/** Formerly forced as locked defaults — kept only so seed can clear isDefault. */
const RETIRED_DEFAULT_PACKAGE_IDS = ["defender", "omi", "guardicore"];

const PACKAGE_CATEGORIES = {
  "Languages & runtimes": ["dotnet-sdk", "go", "java", "nodejs", "openjdk", "php", "python"],
  "Build tools": ["aqt", "maven", "yarn"],
  "Containers & orchestration": ["docker", "docker-compose", "helm", "kubectl"],
  "Databases & cache": ["mongodb", "mysql", "postgres", "redis"],
  Messaging: ["rabbitmq"],
  "Web & proxy": ["nginx"],
  "DevOps & IaC": ["ansible", "terraform", "awscli"],
  Monitoring: ["grafana", "prometheus"],
  Utilities: ["curl", "git", "htop", "jq", "tmux", "vim", "postman"],
};

const PACKAGE_HOSTNAME_CODES = {
  postgres: "psql",
  mysql: "msql",
  mongodb: "mdb",
  oracledb: "odb",
};

const APPLICATION_ROLES = [
  {
    id: "web",
    label: "Web server",
    selection: "multi",
    allowMultiOverride: false,
    defaultOptionId: null,
    options: ["nginx", "nodejs"],
    sortOrder: 0,
  },
  {
    id: "db",
    label: "Database",
    selection: "single",
    allowMultiOverride: true,
    defaultOptionId: "postgres",
    options: ["postgres", "mysql", "mongodb"],
    sortOrder: 1,
  },
  {
    id: "docker",
    label: "Containers",
    selection: "bundle",
    allowMultiOverride: false,
    defaultOptionId: null,
    options: ["docker", "docker-compose"],
    sortOrder: 2,
  },
  {
    id: "api",
    label: "API / backend",
    selection: "multi",
    allowMultiOverride: false,
    defaultOptionId: null,
    options: ["nodejs", "nginx", "git"],
    sortOrder: 3,
  },
  {
    id: "cache",
    label: "Cache",
    selection: "bundle",
    allowMultiOverride: false,
    defaultOptionId: "redis",
    options: ["redis"],
    sortOrder: 4,
  },
  {
    id: "queue",
    label: "Message queue",
    selection: "bundle",
    allowMultiOverride: false,
    defaultOptionId: "rabbitmq",
    options: ["rabbitmq"],
    sortOrder: 5,
  },
  {
    id: "app",
    label: "General app",
    selection: "suggest",
    allowMultiOverride: false,
    defaultOptionId: null,
    options: ["git", "curl"],
    sortOrder: 6,
  },
  {
    id: "worker",
    label: "Background worker",
    selection: "multi",
    allowMultiOverride: false,
    defaultOptionId: null,
    options: ["nodejs", "git"],
    sortOrder: 7,
  },
];

const PACKAGE_DISPLAY_NAMES = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mongodb: "MongoDB",
  redis: "Redis",
  rabbitmq: "RabbitMQ",
  nodejs: "Node.js",
  openjdk: "OpenJDK",
  "dotnet-sdk": ".NET SDK",
  "docker-compose": "Docker Compose",
  nginx: "Nginx",
  python: "Python",
  java: "Java",
  php: "PHP",
  go: "Go",
};

function categoryForPackage(id) {
  for (const [cat, ids] of Object.entries(PACKAGE_CATEGORIES)) {
    if (ids.includes(id)) return cat;
  }
  return "Uncategorized";
}

function displayNameForPackage(id) {
  return PACKAGE_DISPLAY_NAMES[id] || id;
}

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
  { key: "assign_ip", label: "Attaching network", active: "Connecting the NIC — IP via DHCP…", done: "Network attached · DHCP", eta: 12, group: "build" },
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
        name: displayNameForPackage(id),
        category: categoryForPackage(id),
        hostnameCode: PACKAGE_HOSTNAME_CODES[id] || null,
        enabled: true,
        sortOrder: i,
      })),
    });
    console.log(`[seed] ${PACKAGE_CATALOG.length} packages`);
  } else {
    // Backfill category when missing; always refresh known hostname codes.
    for (const id of PACKAGE_CATALOG) {
      const cat = categoryForPackage(id);
      await prisma.package.updateMany({
        where: { id, OR: [{ category: null }, { category: "" }] },
        data: { category: cat },
      });
    }
  }

  for (const [id, code] of Object.entries(PACKAGE_HOSTNAME_CODES)) {
    const updated = await prisma.package.updateMany({
      where: { id },
      data: {
        hostnameCode: code,
        category: categoryForPackage(id) || "Databases & cache",
        name: displayNameForPackage(id),
      },
    });
    if (!updated.count && id !== "oracledb") {
      await prisma.package.create({
        data: {
          id,
          name: displayNameForPackage(id),
          category: "Databases & cache",
          hostnameCode: code,
          enabled: true,
          sortOrder: 900,
        },
      }).catch(() => {});
    }
  }
  console.log(`[seed] hostname codes ensured (${Object.keys(PACKAGE_HOSTNAME_CODES).length})`);

  // Refresh friendly names when still equal to raw id.
  for (const [id, name] of Object.entries(PACKAGE_DISPLAY_NAMES)) {
    await prisma.package.updateMany({
      where: { id, name: id },
      data: { name },
    });
  }

  // Ensure oracledb stub exists for future role option (disabled until admin enables).
  await prisma.package.upsert({
    where: { id: "oracledb" },
    create: {
      id: "oracledb",
      name: "Oracle Database",
      category: "Databases & cache",
      hostnameCode: "odb",
      enabled: false,
      sortOrder: 2000,
    },
    update: { hostnameCode: "odb", category: "Databases & cache" },
  });

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
          isDefault: false,
          enabled: b.enabled,
          sortOrder: b.sortOrder,
        },
        update: { name: b.name, installPkg: b.pkg, isDefault: false, enabled: b.enabled },
      });
    }
    await prisma.securityBaselineAgent.deleteMany({});
    console.log(`[seed] migrated ${legacy.length} baseline agents → optional packages`);
  }

  // Clear locked-default flag on retired security agents (defender / omi / guardicore).
  const cleared = await prisma.package.updateMany({
    where: { id: { in: RETIRED_DEFAULT_PACKAGE_IDS } },
    data: { isDefault: false },
  });
  if (cleared.count) {
    console.log(`[seed] cleared isDefault on ${cleared.count} retired package(s)`);
  }

  for (const role of APPLICATION_ROLES) {
    await prisma.applicationRole.upsert({
      where: { id: role.id },
      create: {
        id: role.id,
        label: role.label,
        selection: role.selection,
        allowMultiOverride: !!role.allowMultiOverride,
        defaultOptionId: role.defaultOptionId,
        options: role.options,
        enabled: true,
        sortOrder: role.sortOrder,
      },
      update: {
        // Keep admin customizations after first seed: only fill if we want to refresh labels/modes once.
        // Re-seed modes/options so design changes land; admins can re-edit after upgrade.
        label: role.label,
        selection: role.selection,
        allowMultiOverride: !!role.allowMultiOverride,
        defaultOptionId: role.defaultOptionId,
        options: role.options,
        sortOrder: role.sortOrder,
      },
    });
  }
  console.log(`[seed] ${APPLICATION_ROLES.length} application roles ensured`);

  // Keep hostname application list in sync with enabled role ids when empty/default.
  const roleIds = APPLICATION_ROLES.map((r) => r.id);
  const appsRow = await prisma.setting.findUnique({ where: { key: "HOSTNAME_APPLICATIONS" } });
  if (!appsRow?.value) {
    await prisma.setting.upsert({
      where: { key: "HOSTNAME_APPLICATIONS" },
      create: { key: "HOSTNAME_APPLICATIONS", value: roleIds.join(", ") },
      update: { value: roleIds.join(", ") },
    });
  }

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
