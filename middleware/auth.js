const jwt = require("jsonwebtoken");
const getOrgDetailsById = require("../utils/getOrgDetailsById");
const { getBlacklistedTokenModel } = require("../utils/getTokenCheck");

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const BlacklistedToken = await getBlacklistedTokenModel();
    const present = await BlacklistedToken.isTokenPresent(decoded.jti);
    if (!present) {
      console.error("Chat-auth: Token JTI not found in blacklisted_tokens table. jti:", decoded.jti);
      return res.status(401).json({ error: "Unauthorized" });
    }

    req.user = decoded;

    const orgId = Number(decoded.org_id);
    if (!Number.isFinite(orgId) || orgId < 0) {
      return res.status(400).json({ error: "Organization ID missing in token" });
    }

    const orgData = await getOrgDetailsById(orgId);
    if (!orgData) return res.status(404).json({ error: "Org not found" });
    if (orgData.status === "Inactive") {
      return res.status(401).json({ error: "Org is inactive" });
    }

    next();
  } catch (error) {
    console.error("Chat-auth: Error:", error.message);
    if (error?.message === "jwt expired") {
      return res.status(401).json({ error: "token expired" });
    }
    return res.status(401).json({ error: "Authentication failed" });
  }
};

module.exports = { authMiddleware };
