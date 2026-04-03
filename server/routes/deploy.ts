import { Router } from "express";
import axios from "axios";
import yaml from "js-yaml";
import fs from "fs";
import path from "path";
import { CONFIG } from "../utils/config";
import { deployComposeToEnvironment } from "../services/runtime";
import { getEnvironment, getLocalEnvironmentId } from "../services/platform";
import { appendJobEvent, createJob, updateJob } from "../services/jobs";

const router = Router();

router.get("/dockerhub", async (req, res) => {
  const image = req.query.image as string;
  if (!image) return res.status(400).json({ error: "必须提供 image 参数" });

  try {
    let [namespace, repo] = image.split('/');
    if (!repo) {
      repo = namespace;
      namespace = 'library';
    }
    const [repoName, tag] = repo.split(':');

    const hubRes = await axios.get(`https://hub.docker.com/v2/repositories/${namespace}/${repoName}`);
    const description = hubRes.data.description;

    const composeObj = {
      services: {
        [repoName]: {
          image: image,
          container_name: repoName,
          restart: "unless-stopped",
          ports: ["8080:80"],
          networks: ["proxy_net"]
        }
      },
      networks: {
        proxy_net: {
          external: true,
          name: "proxy_net"
        }
      }
    };

    const composeYaml = yaml.dump(composeObj);
    res.json({ success: true, compose: composeYaml, description });
  } catch (error: any) {
    res.status(500).json({ error: "获取 DockerHub 信息失败", details: error.message });
  }
});

router.post("/compose", async (req, res) => {
  const { name, composeYaml, remarks, environmentId = getLocalEnvironmentId(), serverId } = req.body;
  const targetId = serverId || environmentId;
  try {
    const config = yaml.load(composeYaml);
    const environment = getEnvironment(targetId);
    await deployComposeToEnvironment(targetId, name, composeYaml, remarks, (req as any).user?.username || "admin");
    const projectDir = path.join(CONFIG.DATA_DIR, "projects", targetId, name);
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }
    res.json({
      success: true,
      message: `成功部署 ${name} 到 ${environment.displayName}`,
      config,
      environment,
    });
  } catch (error: any) {
    res.status(400).json({ error: "无效的 YAML 格式或部署失败", details: error.message });
  }
});

router.post("/jobs", async (req, res) => {
  const { name, composeYaml, remarks, serverId = getLocalEnvironmentId() } = req.body;
  const actor = (req as any).user?.username || "admin";
  const jobId = createJob({
    kind: "deploy",
    sourceEnvironmentId: serverId,
    status: "running",
    metadata: {
      name,
      remarks: remarks || null,
    },
  });
  appendJobEvent(jobId, "info", "plan", `开始部署 ${name} 到服务器 ${serverId}`);

  try {
    const config = yaml.load(composeYaml);
    const environment = getEnvironment(serverId);
    await deployComposeToEnvironment(serverId, name, composeYaml, remarks, actor);
    updateJob(jobId, "completed", {
      name,
      serverId,
      remarks: remarks || null,
      config,
    });
    appendJobEvent(jobId, "info", "apply", `部署 ${name} 已完成`);
    res.json({
      success: true,
      jobId,
      environment,
      message: `成功部署 ${name} 到 ${environment.displayName}`,
    });
  } catch (error: any) {
    updateJob(jobId, "failed", {
      name,
      serverId,
      remarks: remarks || null,
      error: error.message,
    });
    appendJobEvent(jobId, "error", "apply", `部署失败：${error.message}`);
    res.status(400).json({ error: "部署任务失败", details: error.message, jobId });
  }
});

export default router;
