const express = require("express");
const multer = require("multer");
const router = express.Router();
const { BlobServiceClient } = require("@azure/storage-blob");

const AZURE_STORAGE_CONNECTION_STRING =
  process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = "new"; // create this container in Azure portal

const blobServiceClient = BlobServiceClient.fromConnectionString(
  AZURE_STORAGE_CONNECTION_STRING,
);
const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);

const upload = multer({ storage: multer.memoryStorage() });

router.post("/upload", upload.any(), async (req, res) => {
  try {
    console.log("Container URL:", containerClient);

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded",
      });
    }

    const uploadedFiles = [];

    for (const file of req.files) {
      console.log("File received:", {
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        hasBuffer: !!file.buffer,
      });
      const blobName = `${Date.now()}-${file.originalname}`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      console.log("Uploading to:", blockBlobClient.url);

      // Upload buffer directly
      await blockBlobClient.uploadData(file.buffer, {
        blobHTTPHeaders: { blobContentType: file.mimetype },
      });

      // Public URL (works if container is set to "Blob" access level in Azure)
      const fileUrl = blockBlobClient.url;

      uploadedFiles.push(fileUrl);
    }

    res.status(200).json({
      success: true,
      message: "File(s) uploaded successfully to Azure!",
      files: uploadedFiles,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// const storage = multer.diskStorage({
//   destination: (req, file, cb) => {
//     cb(null, "uploads"); // Save to 'uploads' folder
//   },
//   filename: (req, file, cb) => {
//     const uniqueName = `${Date.now()}-${file.originalname}`;
//     cb(null, uniqueName);
//   },
// });

// const upload = multer({ storage });

// Route to upload image
router.post("/uploadss", upload.any(), (req, res) => {
  try {
    // Check if any files were uploaded
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded",
      });
    }

    // Create URLs for all uploaded files
    const fileInfos = req.files.map((file) => `/uploads/${file.filename}`);

    res.status(200).json({
      success: true,
      message: "File(s) uploaded successfully!",
      files: fileInfos,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

module.exports = router;
