const express = require("express");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const router = express.Router();
const responseModel = require("../models/ResponseModel");
const { logger } = require("../jobLogger");
const { uploadMessages } = require("../constants");

// Multer in-memory storage
const upload = multer({ storage: multer.memoryStorage() });

// 📌 Upload API (Azure Storage)
// Route to upload images
router.post("/upload/:name", upload.any(), async (req, res) => {
  try {
    const { name } = req.params;
    if (!req.files || req.files.length === 0)
      return res
        .status(400)
        .json(new responseModel(false, uploadMessages.noFile));

    const uploadedFiles = [];

    const AZURE_STORAGE_CONNECTION_STRING =
      process.env.AZURE_STORAGE_CONNECTION_STRING;

    // Initialize Blob Service Client
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      AZURE_STORAGE_CONNECTION_STRING,
    );
    const containerClient = blobServiceClient.getContainerClient(name);

    if (!containerClient) {
      throw new Error("Failed to get container client");
    }

    for (const file of req.files) {
      const blobName = `${Date.now()}-${file.originalname}`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      // Upload buffer
      await blockBlobClient.uploadData(file.buffer, {
        blobHTTPHeaders: { blobContentType: file.mimetype },
      });

      // Public URL (only works if container access level is set to "Blob" or SAS token is used)
      uploadedFiles.push(blockBlobClient.url);
    }

    return res
      .status(200)
      .json(new responseModel(true, uploadMessages.success, uploadedFiles));
  } catch (error) {
    logger.error("Azure upload error:", error);
    return res
      .status(500)
      .json(new responseModel(false, uploadMessages.failure));
  }
});

module.exports = router;
