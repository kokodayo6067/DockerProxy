import { localDocker } from "./docker-client";
import { containerAction as runtimeContainerAction, getContainerLogs as runtimeGetContainerLogs, listRuntimeContainers } from "./runtime";
import { getLocalEnvironmentId } from "./platform";

export const docker = localDocker;

export async function getContainers(environmentId = getLocalEnvironmentId()) {
  return listRuntimeContainers(environmentId);
}

export async function containerAction(environmentId: string, id: string, action: string, actor = "admin") {
  return runtimeContainerAction(environmentId, id, action, actor);
}

export async function getContainerLogs(environmentId: string, id: string, structured = false) {
  return runtimeGetContainerLogs(environmentId, id, structured);
}
