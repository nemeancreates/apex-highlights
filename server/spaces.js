// ================================
// SPACES — DigitalOcean Spaces (S3-compatible) client + upload/delete.
// If SPACES_KEY/SPACES_SECRET are missing, spacesClient stays null and
// uploads remain local — same graceful fallback as before.
// ================================
const fs = require('fs');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { log } = require('./logger');
const {
  SPACES_REGION,
  SPACES_BUCKET,
  SPACES_ENDPOINT,
  SPACES_CDN_BASE
} = require('./config');

let spacesClient = null;
if (process.env.SPACES_KEY && process.env.SPACES_SECRET) {
  spacesClient = new S3Client({
    endpoint: SPACES_ENDPOINT,
    region: SPACES_REGION,
    credentials: {
      accessKeyId: process.env.SPACES_KEY,
      secretAccessKey: process.env.SPACES_SECRET
    }
  });
  console.log('Spaces configured:', SPACES_BUCKET, SPACES_REGION);
} else {
  console.log('WARNING: Spaces not configured — SPACES_KEY/SPACES_SECRET missing, uploads will stay local');
}

function isSpacesEnabled() {
  return spacesClient !== null;
}

// Push a local file to Spaces, return its CDN URL. Deletes the local file on success.
async function uploadToSpaces(localPath, objectKey, contentType) {
  const fileBuffer = fs.readFileSync(localPath);
  await spacesClient.send(new PutObjectCommand({
    Bucket: SPACES_BUCKET,
    Key: objectKey,
    Body: fileBuffer,
    ContentType: contentType,
    ACL: 'public-read'
  }));
  try { fs.unlinkSync(localPath); } catch (e) {}
  return `${SPACES_CDN_BASE}/${objectKey}`;
}

// Delete an object from Spaces by its key (for retention/purge)
async function deleteFromSpaces(objectKey) {
  if (!spacesClient) return;
  try {
    await spacesClient.send(new DeleteObjectCommand({ Bucket: SPACES_BUCKET, Key: objectKey }));
  } catch (e) {
    log('warn', 'spaces_delete_failed', { key: objectKey, error: e.message });
  }
}

module.exports = { isSpacesEnabled, uploadToSpaces, deleteFromSpaces };
