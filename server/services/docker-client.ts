import Docker from "dockerode";

export const localDocker = new Docker({ socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock" });
