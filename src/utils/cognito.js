// src/utils/cognito.js - AWS Cognito Helper Functions
const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');

// ================== REGION CONFIGURATION ==================
// Ensure AWS SDK uses the correct region (Mumbai)
AWS.config.update({
    region: process.env.REGION || 'ap-south-1'
});

// Configure AWS SDK
const cognito = new AWS.CognitoIdentityServiceProvider();

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
// const CLIENT_ID = process.env.COGNITO_CLIENT_ID; // Not used in Admin calls

// ==========================================================
// 1. CREATE USER
// ==========================================================
const createUser = async (email, password, name, role) => {
    try {
        console.log(`👤 Creating Cognito user: ${email}`);

        // ⚠️ CRITICAL FIX: Removed 'custom:role'
        // We only send standard attributes (email, name) to avoid "Attribute does not exist" errors.
        // The 'role' is stored in DynamoDB, which is sufficient.
        const params = {
            UserPoolId: USER_POOL_ID,
            Username: email,
            TemporaryPassword: password,
            UserAttributes: [
                { Name: 'email', Value: email },
                { Name: 'email_verified', Value: 'true' }, // Auto-verify email
                { Name: 'name', Value: name }
            ],
            MessageAction: 'SUPPRESS' // Don't send default AWS invitation email
        };
        
        // 1. Create the user
        const result = await cognito.adminCreateUser(params).promise();
        
        // 2. Set the password as permanent (so they don't have to change it on first login)
        await cognito.adminSetUserPassword({
            UserPoolId: USER_POOL_ID,
            Username: email,
            Password: password,
            Permanent: true
        }).promise();
        
        console.log('✅ Cognito user created successfully');

        return {
            uid: result.User.Username,
            email: email,
            name: name,
            role: role // We pass the role back so auth.js can save it to DynamoDB
        };
    } catch (error) {
        console.error('❌ Error creating Cognito user:', error);
        // Provide a clearer error message for the frontend
        if (error.code === 'InvalidPasswordException') {
            throw new Error('Password too weak. Use 8+ chars, uppercase, lowercase, number, & symbol.');
        }
        if (error.code === 'UsernameExistsException') {
            throw new Error('User already exists with this email.');
        }
        throw error;
    }
};

// ==========================================================
// 2. GET USER
// ==========================================================
const getUser = async (username) => {
    try {
        const params = {
            UserPoolId: USER_POOL_ID,
            Username: username
        };
        
        const result = await cognito.adminGetUser(params).promise();
        
        // Parse user attributes
        const attributes = {};
        if (result.UserAttributes) {
            result.UserAttributes.forEach(attr => {
                attributes[attr.Name] = attr.Value;
            });
        }
        
        return {
            uid: result.Username,
            email: attributes.email,
            name: attributes.name,
            // Fallback for role if not in Cognito (it will be fetched from DynamoDB usually)
            role: attributes['custom:role'] || 'user', 
            status: result.UserStatus,
            enabled: result.Enabled,
            created: result.UserCreateDate,
            modified: result.UserLastModifiedDate
        };
    } catch (error) {
        if (error.code === 'UserNotFoundException') {
            return null;
        }
        console.error('Error getting Cognito user:', error);
        throw error;
    }
};

// ==========================================================
// 3. UPDATE USER
// ==========================================================
const updateUser = async (username, attributes) => {
    try {
        // Filter out custom attributes that might not exist in Schema
        const userAttributes = [];
        
        if (attributes.email) userAttributes.push({ Name: 'email', Value: attributes.email });
        if (attributes.name) userAttributes.push({ Name: 'name', Value: attributes.name });
        if (attributes.email_verified) userAttributes.push({ Name: 'email_verified', Value: String(attributes.email_verified) });

        // Only add custom:role if you are SURE it exists in your Schema
        // if (attributes.role) userAttributes.push({ Name: 'custom:role', Value: attributes.role });

        const params = {
            UserPoolId: USER_POOL_ID,
            Username: username,
            UserAttributes: userAttributes
        };
        
        await cognito.adminUpdateUserAttributes(params).promise();
        return true;
    } catch (error) {
        console.error('Error updating Cognito user:', error);
        throw error;
    }
};

// ==========================================================
// 4. DELETE USER
// ==========================================================
const deleteUser = async (username) => {
    try {
        const params = {
            UserPoolId: USER_POOL_ID,
            Username: username
        };
        
        await cognito.adminDeleteUser(params).promise();
        return true;
    } catch (error) {
        console.error('Error deleting Cognito user:', error);
        throw error;
    }
};

// ==========================================================
// 5. UTILITIES (JWT)
// ==========================================================
const verifyToken = (token) => {
    try {
        if (!token) return null;
        // Remove 'Bearer ' if present
        const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token;
        return jwt.verify(cleanToken, process.env.JWT_SECRET);
    } catch (error) {
        console.error('Error verifying JWT token:', error.message);
        return null;
    }
};

const generateToken = (user) => {
    try {
        const payload = {
            uid: user.uid,
            email: user.email,
            name: user.name,
            role: user.role,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 hours
        };
        
        return jwt.sign(payload, process.env.JWT_SECRET);
    } catch (error) {
        console.error('Error generating JWT token:', error);
        throw error;
    }
};

module.exports = {
    createUser,
    getUser,
    updateUser,
    deleteUser,
    verifyToken,
    generateToken
};
