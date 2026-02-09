import admin from "../firebase/admin.js";
import prisma from "../prisma.js";

export async function createContext({ request }) {
  const authHeader = request.headers.get("authorization");

  let userId = null;
  let email = null;
  let isSuperAdmin = false;

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.replace("Bearer ", "");

    try {
      const decoded = await admin.auth().verifyIdToken(token);

      userId = decoded.uid;
      email = decoded.email;
      isSuperAdmin = decoded.superAdmin === true;
    } catch (err) {
      console.warn("Invalid Firebase token");
    }
  }

  return {
    prisma,
    userId,
    email,
    isSuperAdmin,
  };
}
