const express = require("express");
const bodyParser = require("body-parser");
const TelegramBot = require("node-telegram-bot-api");
const { v4: uuidv4 } = require("uuid");
const firebaseAdmin = require("firebase-admin");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// Initialize Firebase Admin SDK
const serviceAccount = require("/etc/secrets/serviceAccountKey.json");
firebaseAdmin.initializeApp({
  credential: firebaseAdmin.credential.cert(serviceAccount),
  storageBucket: "image-upload-51e97.appspot.com",
  databaseURL: "https://image-upload-51e97-default-rtdb.firebaseio.com",
});
const bucket = firebaseAdmin.storage().bucket();
const db = firebaseAdmin.database();

// Initialize Express Server
const app = express();
app.use(bodyParser.json());

// Telegram Bot Token
const BOT_TOKEN = "7595609232:AAG5KBwqq6wfBTRqO_Vw1Ql-nxn_6NojJ5I";
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Store user interaction data
const userSteps = {};

// Helper function to download a file with progress logging
const downloadFileWithProgress = async (url, filepath) => {
  const response = await axios({ url, method: "GET", responseType: "stream" });
  const totalLength = parseInt(response.headers["content-length"], 10);
  let downloaded = 0;

  console.log(`Starting download of ${url}`);
  const writer = fs.createWriteStream(filepath);
  response.data.pipe(writer);

  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    const percentage = ((downloaded / totalLength) * 100).toFixed(2);
    const downloadedMB = (downloaded / (1024 * 1024)).toFixed(2);
    const totalMB = (totalLength / (1024 * 1024)).toFixed(2);
    console.log(`Downloading... ${percentage}% (${downloadedMB} MB / ${totalMB} MB)`);
  });

  return new Promise((resolve, reject) => {
    writer.on("finish", () => {
      console.log("Download complete.");
      resolve();
    });
    writer.on("error", reject);
  });
};

// Helper function to upload a file to Firebase Storage with progress logging
const uploadToFirebaseWithProgress = async (localPath, firebasePath) => {
  const token = uuidv4();
  const file = bucket.file(firebasePath);
  const stream = fs.createReadStream(localPath);

  const stats = fs.statSync(localPath);
  const totalSize = stats.size;
  let uploaded = 0;

  console.log(`Starting upload of ${localPath} to Firebase`);

  return new Promise((resolve, reject) => {
    const uploadStream = file.createWriteStream({
      metadata: {
        metadata: {
          firebaseStorageDownloadTokens: token,
        },
      },
    });

    stream.on("data", (chunk) => {
      uploaded += chunk.length;
      const percentage = ((uploaded / totalSize) * 100).toFixed(2);
      const uploadedMB = (uploaded / (1024 * 1024)).toFixed(2);
      const totalMB = (totalSize / (1024 * 1024)).toFixed(2);
      console.log(`Uploading... ${percentage}% (${uploadedMB} MB / ${totalMB} MB)`);
    });

    stream.pipe(uploadStream);

    uploadStream.on("finish", () => {
      console.log("Upload complete.");
      const signedURL = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(
        firebasePath
      )}?alt=media&token=${token}`;
      resolve(signedURL);
    });

    uploadStream.on("error", reject);
  });
};

// Start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "Welcome! Send /upload to start uploading video details.");
});

// Upload command
bot.onText(/\/upload/, (msg) => {
  const chatId = msg.chat.id;
  userSteps[chatId] = { step: "title" };
  bot.sendMessage(chatId, "Send the title of the video.");
});

// Handle messages
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!userSteps[chatId]) return;

  const step = userSteps[chatId].step;

  if (step === "title") {
    userSteps[chatId].title = text;
    userSteps[chatId].step = "videoLink";
    bot.sendMessage(chatId, "Send the video link (URL).");
  } else if (step === "videoLink") {
    userSteps[chatId].videoLink = text;
    userSteps[chatId].step = "imageLink";
    bot.sendMessage(chatId, "Send the image link (URL) for the thumbnail.");
  } else if (step === "imageLink") {
    userSteps[chatId].imageLink = text;
    userSteps[chatId].step = "uploading";

    const { title, videoLink, imageLink } = userSteps[chatId];

    try {
      const videoFile = path.join(__dirname, `${title}.mp4`);
      const imageFile = path.join(__dirname, `${title}.jpg`);

      // Download video and image files with progress logging
      await downloadFileWithProgress(videoLink, videoFile);
      await downloadFileWithProgress(imageLink, imageFile);

      // Upload files to Firebase Storage with progress logging
      const videoFirebaseURL = await uploadToFirebaseWithProgress(videoFile, `videos/${title}.mp4`);
      const imageFirebaseURL = await uploadToFirebaseWithProgress(imageFile, `thumbnails/${title}.jpg`);

      // Save links to Firebase Realtime Database
      await db.ref("videos").push({
        title,
        videoURL: videoFirebaseURL,
        thumbnailURL: imageFirebaseURL,
      });

      // Clean up local files
      fs.unlinkSync(videoFile);
      fs.unlinkSync(imageFile);

      bot.sendMessage(chatId, `Upload successful!\n\nTitle: ${title}\nVideo: ${videoFirebaseURL}\nImage: ${imageFirebaseURL}`);
    } catch (err) {
      console.error("Error during upload:", err);
      bot.sendMessage(chatId, "An error occurred while processing your request. Please try again.");
    } finally {
      delete userSteps[chatId];
    }
  }
});

// Start Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
