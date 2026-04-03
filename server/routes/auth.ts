import { Router } from "express";
import jwt from "jsonwebtoken";
import { CONFIG } from "../utils/config";
import { getDb } from "../db";
import { verifyPassword } from "../services/security";

const router = Router();

router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const db = getDb();
  const user = db
    .prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
    .get(username) as { id: string; username: string; password_hash: string } | undefined;

  if (user && (await verifyPassword(password, user.password_hash))) {
    const token = jwt.sign({ username }, CONFIG.JWT_SECRET, { expiresIn: '7d' });
    res.cookie("token", token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    return res.json({ success: true, token });
  }
  
  res.status(401).json({ error: "用户名或密码错误" });
});

router.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ success: true });
});

router.get("/me", (req, res) => {
  const token = req.cookies?.token || req.headers.authorization?.split(" ")[1];
  if (!token) return res.json({ loggedIn: false });
  
  try {
    const decoded = jwt.verify(token, CONFIG.JWT_SECRET);
    res.json({ loggedIn: true, user: decoded });
  } catch (err) {
    res.json({ loggedIn: false });
  }
});

export default router;
