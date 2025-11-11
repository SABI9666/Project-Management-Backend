// src/utils/s3.js - S3 Helper Functions
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

// Configure AWS SDK
const s3 = new AWS.S3({
    region: process.env.REGION || 'ap-south-1',
    signatureVersion: 'v4'
});

const BUCKET_NAME = process.env.S3_BUCKET;

// Upload file to S3
const uploadFile = async (buffer, filename, mimetype, folder = '') => {
    try {
        const key = folder ? `${folder}/${uuidv4()}-${filename}` : `${uuidv4()}-${filename}`;
        
        const params = {
            Bucket: BUCKET_NAME,
            Key: key,
            Body: buffer,
            ContentType: mimetype,
            ACL: 'private'
        };
        
        await s3.putObject(params).promise();
        
        return {
            key: key,
            bucket: BUCKET_NAME,
            url: `https://${BUCKET_NAME}.s3.${process.env.REGION}.amazonaws.com/${key}`
        };
    } catch (error) {
        console.error('Error uploading file to S3:', error);
        throw error;
    }
};

// Get signed URL for private file access
const getSignedUrl = async (key, expiresIn = 3600) => {
    try {
        const params = {
            Bucket: BUCKET_NAME,
            Key: key,
            Expires: expiresIn // URL expires in seconds (default 1 hour)
        };
        
        const url = await s3.getSignedUrlPromise('getObject', params);
        return url;
    } catch (error) {
        console.error('Error generating signed URL:', error);
        throw error;
    }
};

// Delete file from S3
const deleteFile = async (key) => {
    try {
        const params = {
            Bucket: BUCKET_NAME,
            Key: key
        };
        
        await s3.deleteObject(params).promise();
        return true;
    } catch (error) {
        console.error('Error deleting file from S3:', error);
        throw error;
    }
};

// Delete multiple files from S3
const deleteFiles = async (keys) => {
    try {
        if (keys.length === 0) return true;
        
        const params = {
            Bucket: BUCKET_NAME,
            Delete: {
                Objects: keys.map(key => ({ Key: key })),
                Quiet: false
            }
        };
        
        await s3.deleteObjects(params).promise();
        return true;
    } catch (error) {
        console.error('Error deleting multiple files from S3:', error);
        throw error;
    }
};

// List files in a folder
const listFiles = async (prefix = '', maxKeys = 1000) => {
    try {
        const params = {
            Bucket: BUCKET_NAME,
            Prefix: prefix,
            MaxKeys: maxKeys
        };
        
        const result = await s3.listObjectsV2(params).promise();
        return result.Contents || [];
    } catch (error) {
        console.error('Error listing files from S3:', error);
        throw error;
    }
};

// Get file metadata
const getFileMetadata = async (key) => {
    try {
        const params = {
            Bucket: BUCKET_NAME,
            Key: key
        };
        
        const result = await s3.headObject(params).promise();
        return {
            size: result.ContentLength,
            contentType: result.ContentType,
            lastModified: result.LastModified,
            metadata: result.Metadata
        };
    } catch (error) {
        console.error('Error getting file metadata from S3:', error);
        throw error;
    }
};

// Copy file within S3
const copyFile = async (sourceKey, destinationKey) => {
    try {
        const params = {
            Bucket: BUCKET_NAME,
            CopySource: `${BUCKET_NAME}/${sourceKey}`,
            Key: destinationKey
        };
        
        await s3.copyObject(params).promise();
        return destinationKey;
    } catch (error) {
        console.error('Error copying file in S3:', error);
        throw error;
    }
};

// Get presigned POST data for direct browser upload
const getPresignedPost = async (filename, mimetype, folder = '', expiresIn = 3600) => {
    try {
        const key = folder ? `${folder}/${uuidv4()}-${filename}` : `${uuidv4()}-${filename}`;
        
        const params = {
            Bucket: BUCKET_NAME,
            Fields: {
                key: key,
                'Content-Type': mimetype
            },
            Expires: expiresIn,
            Conditions: [
                ['content-length-range', 0, 104857600], // Max 100MB
                { 'Content-Type': mimetype }
            ]
        };
        
        return new Promise((resolve, reject) => {
            s3.createPresignedPost(params, (err, data) => {
                if (err) reject(err);
                else resolve({ ...data, key });
            });
        });
    } catch (error) {
        console.error('Error creating presigned POST:', error);
        throw error;
    }
};

module.exports = {
    s3,
    uploadFile,
    getSignedUrl,
    deleteFile,
    deleteFiles,
    listFiles,
    getFileMetadata,
    copyFile,
    getPresignedPost,
    BUCKET_NAME
};
