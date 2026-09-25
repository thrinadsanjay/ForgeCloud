import { connectDb } from "./db/client.js";
import { syncSchema } from "./db/schemaSync.js";
import { hydrateSettings, applyToEnv, hydrateCostRates } from "./services/settingsStore.js";
import { hydrateUsers, ensureAdminSeed } from "./services/userStore.js";
import { hydratePats } from "./services/patStore.js";
import { hydrateGroups } from "./services/groupStore.js";
import { hydrateMappings } from "./services/mappingStore.js";
import { hydrateRequests } from "./services/requestStore.js";
import { hydrateJobs } from "./services/jobStore.js";
import { hydrateOwnership } from "./services/ownershipStore.js";
import { hydrateExpiry } from "./services/expiryStore.js";
import { hydrateAudit } from "./services/auditService.js";
import { hydrateNotifications } from "./services/notificationStore.js";
import { hydrateChats } from "./services/chatStore.js";
import { hydrateStepTimings } from "./services/stepTimingsStore.js";
import { hydrateAiCache } from "./services/aiOps.js";
import { hydrateCatalog } from "./services/catalogService.js";
import { hydrateServiceNowTickets } from "./services/servicenowTicketStore.js";
import { hydrateDockerHosts } from "./services/dockerHostStore.js";
import { hydrateAppBlueprints, seedAppBlueprintsIfEmpty } from "./services/appCatalogService.js";
import { seedDefaults } from "./scripts/seed-defaults.js";
import { importJsonIfPresent } from "./scripts/migrate-json-to-db.js";

export async function bootstrap() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Set it in backend/.env or docker-compose environment.");
  }
  await connectDb();
  syncSchema();
  await importJsonIfPresent();
  await seedDefaults();
  await seedAppBlueprintsIfEmpty();
  await hydrateSettings();
  applyToEnv(); // before stores that read approval / integration env
  await hydrateUsers();
  await ensureAdminSeed();
  await hydratePats();
  await hydrateGroups();
  await hydrateMappings();
  await hydrateRequests();
  await hydrateServiceNowTickets();
  await hydrateJobs();
  await hydrateOwnership();
  await hydrateExpiry();
  await hydrateAudit();
  await hydrateNotifications();
  await hydrateChats();
  await hydrateStepTimings();
  await hydrateAiCache();
  await hydrateCatalog();
  await hydrateDockerHosts();
  await hydrateAppBlueprints();
  await hydrateCostRates();
  applyToEnv();
}
