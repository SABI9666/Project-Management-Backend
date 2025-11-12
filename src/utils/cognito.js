// src/utils/cognito.js - AWS Cognito Helper Functions
const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');

// ================== THIS IS THE FIX ==================
// Force the AWS SDK to use the correct region for all services
// This ensures Cognito client is created in ap-south-1
AWS.config.update({
    region: process.env.REGION || 'ap-south-1'
});
// ================== END OF FIX ==================

// Configure AWS SDK
const cognito = new AWS.CognitoIdentityServiceProvider();

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;

// Create a new user in Cognito
const createUser = async (email, password, name, role) => {
    try {
        const params = {
            UserPoolId: USER_POOL_ID,
            Username: email,
            TemporaryPassword: password,
            UserAttributes: [
                { Name: 'email', Value: email },
                { Name: 'email_verified', Value: 'true' },
                { Name: 'name', Value: name },
                { Name: 'custom:role', Value: role }
            ],
            MessageAction: 'SUPPRESS' // Don't send welcome email
        };
        
        console.log(`Creating user in pool ${USER_POOL_ID}...`); // Added log
        const result = await cognito.adminCreateUser(params).promise();
        
        // Set permanent password
        await cognito.adminSetUserPassword({
            UserPoolId: USER_POOL_ID,
            Username: email,
            Password: password,
            Permanent: true
        }).promise();
        
        return {
            uid: result.User.Username,
            email: email,
            name: name,
            role: role
        };
    } catch (error) {
        console.error('Error creating Cognito user:', error);
        throw error;
    }
};

// Get user from Cognito
const getUser = async (username) => {
    try {
        const params = {
            UserPoolId: USER_POOL_ID,
            Username: username
        };
        
        const result = await cognito.adminGetUser(params).promise();
        
        // Parse user attributes
        const attributes = {};
        result.UserAttributes.forEach(attr => {
            attributes[attr.Name] = attr.Value;
        });
        
        return {
            uid: result.Username,
            email: attributes.email,
            name: attributes.name,
            role: attributes['custom:role'],
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

// Update user attributes
const updateUser = async (username, attributes) => {
    try {
        const userAttributes = Object.keys(attributes).map(key => ({
            Name: key.startsWith('custom:') ? key : key === 'role' ? 'custom:role' : key,
            Value: String(attributes[key])
        }));
        
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

// Delete user from Cognito
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

// Enable/Disable user
const setUserStatus = async (username, enabled) => {
    try {
        const params = {
            UserPoolId: USER_POOL_ID,
            Username: username
        };
        
        if (enabled) {
            await cognito.adminEnableUser(params).promise();
        } else {
            await cognito.adminDisableUser(params).promise();
        }
        
        return true;
    } catch (error) {
        console.error('Error setting Cognito user status:', error);
        throw error;
    }
};

// Reset user password
const resetPassword = async (username, newPassword) => {
    try {
        const params = {
            UserPoolId: USER_POOL_ID,
            Username: username,
            Password: newPassword,
            Permanent: true
        };
        
        await cognito.adminSetUserPassword(params).promise();
        return true;
    } catch (error) {
        console.error('Error resetting Cognito user password:', error);
        throw error;
    }
};

// List users by role
const listUsersByRole = async (role) => {
    try {
        const params = {
            UserPoolId: USER_POOL_ID,
            Filter: `custom:role = "${role}"`,
            Limit: 60
        };
        
        const result = await cognito.listUsers(params).promise();
        
        return result.Users.map(user => {
            const attributes = {};
            user.Attributes.forEach(attr => {
                attributes[attr.Name] = attr.Value;
            });
            
            return {
                uid: user.Username,
                email: attributes.email,
                name: attributes.name,
                role: attributes['custom:role'],
                status: user.UserStatus,
                enabled: user.Enabled
            };
        });
    } catch (error) {
        console.error('Error listing Cognito users:', error);
        throw error;
    }
};

// Verify JWT token (for custom JWT implementation)
const verifyToken = (token) => {
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        return decoded;
    } catch (error) {
        console.error('Error verifying JWT token:', error);
        return null;
    }
};

// Generate JWT token (for custom JWT implementation)
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
    cognito,
    createUser,
    getUser,
    updateUser,
    deleteUser,
    setUserStatus,
    resetPassword,
    listUsersByRole,
    verifyToken,
    generateToken
};
