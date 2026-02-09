import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      "/Users/godspeed/Desktop/Freelance/Rental-CMS/apps/backend/firebase_secrets.json",
    ),
  });
}

export default admin;
