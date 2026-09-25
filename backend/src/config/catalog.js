// Legacy re-exports — catalog data now lives in PostgreSQL via catalogService.js
export {
  listPackageIds as PACKAGE_CATALOG,
  listContainerTemplates as CONTAINER_TEMPLATES,
  listStackTemplates as STACKS,
  findContainerTemplate,
  findStack,
  findVmTemplate,
} from "../services/catalogService.js";

export const VM_TEMPLATES = [];
