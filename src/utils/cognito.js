// src/utils/cognito.js - AWS Cognito Helper Functions (COMPLETE WITH SECRET_HASH SUPPORT)
const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Configure AWS SDK with explicit region
AWS.config.update({
    region: process.env.REGION || 'ap-south-1'
});

const cognito = new AWS.CognitoIdentityServiceProvider();

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const CLIENT_SECRET = process.env.COGNITO_CLIENT_SECRET; // Add this to your .env file

// ==========================================================
// HELPER: CALCULATE SECRET_HASH (REQUIRED FOR CLIENT SECRET)
// ==========================================================
const calculateSecretHash = (username, clientId, clientSecret) => {
    if (!clientSecret) {
        // If no client secret, return undefined (for app clients without secret)
        return undefined;
    }
    
    return crypto
        .createHmac('SHA256', clientSecret)
        .update(username + clientId)
        .digest('base64');
};

// ==========================================================
// 1. CREATE USER IN COGNITO
// ==========================================================
const createUser = async (email, password, name, role) => {
    try {
        console.log(`👤 Creating Cognito user: ${email}`);
        console.log(`📋 User Pool ID: ${USER_POOL_ID}`);

        // Validate password meets Cognito requirements
        if (!validatePassword(password)) {
            throw new Error('Password must be at least 8 characters and contain uppercase, lowercase, number, and special character');
        }

        // Step 1: Create user with temporary password
        const createParams = {
            UserPoolId: USER_POOL_ID,
            Username: email,
            TemporaryPassword: password,
            UserAttributes: [
                { Name: 'email', Value: email },
                { Name: 'email_verified', Value: 'true' },
                { Name: 'name', Value: name }
            ],
            MessageAction: 'SUPPRESS' // Don't send AWS email
        };
        
        console.log('🔧 Creating user in Cognito...');
        const result = await cognito.adminCreateUser(createParams).promise();
        console.log('✅ User created in Cognito');
        
        // Step 2: Set permanent password
        console.log('🔑 Setting permanent password...');
        await cognito.adminSetUserPassword({
            UserPoolId: USER_POOL_ID,
            Username: email,
            Password: password,
            Permanent: true
        }).promise();
        console.log('✅ Password set as permanent');
        
        return {
            uid: result.User.Username,
            email: email,
            name: name,
            role: role
        };
    } catch (error) {
        console.error('❌ Error creating Cognito user:', error);
        
        // Provide user-friendly error messages
        if (error.code === 'InvalidPasswordException') {
            throw new Error('Password must be at least 8 characters with uppercase, lowercase, number, and special character (!@#$%^&*)');
        }
        if (error.code === 'UsernameExistsException') {
            throw new Error('User already exists with this email');
        }
        if (error.code === 'InvalidParameterException') {
            throw new Error('Invalid user parameters. Please check all fields.');
        }
        if (error.code === 'ResourceNotFoundException') {
            throw new Error('Cognito User Pool not found. Please check configuration.');
        }
        
        throw new Error(`Cognito error: ${error.message}`);
    }
};

// ==========================================================
// 2. AUTHENTICATE USER (LOGIN) - WITH SECRET_HASH SUPPORT
// ==========================================================
const authenticateUser = async (email, password) => {
    try {
        console.log(`🔐 Authenticating user: ${email}`);
        
        // Calculate SECRET_HASH if client secret exists
        const secretHash = calculateSecretHash(email, CLIENT_ID, CLIENT_SECRET);
        
        const authParameters = {
            USERNAME: email,
            PASSWORD: password
        };
        
        // Add SECRET_HASH if it exists
        if (secretHash) {
            authParameters.SECRET_HASH = secretHash;
            console.log('🔑 Using SECRET_HASH for authentication');
        }
        
        const params = {
            AuthFlow: 'ADMIN_NO_SRP_AUTH',
            UserPoolId: USER_POOL_ID,
            ClientId: CLIENT_ID,
            AuthParameters: authParameters
        };
        
        const result = await cognito.adminInitiateAuth(params).promise();
        
        console.log('✅ Authentication successful');
        
        return {
            success: true,
            accessToken: result.AuthenticationResult.AccessToken,
            idToken: result.AuthenticationResult.IdToken,
            refreshToken: result.AuthenticationResult.RefreshToken
        };
    } catch (error) {
        console.error('❌ Authentication error:', error);
        
        if (error.code === 'NotAuthorizedException') {
            throw new Error('Invalid email or password');
        }
        if (error.code === 'UserNotFoundException') {
            throw new Error('User not found');
        }
        if (error.code === 'UserNotConfirmedException') {
            throw new Error('User account is not confirmed');
        }
        
        throw new Error(`Authentication failed: ${error.message}`);
    }
};

// ==========================================================
// 3. GET USER FROM COGNITO
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
// 4. UPDATE USER ATTRIBUTES
// ==========================================================
const updateUser = async (username, attributes) => {
    try {
        const userAttributes = [];
        
        if (attributes.email) userAttributes.push({ Name: 'email', Value: attributes.email });
        if (attributes.name) userAttributes.push({ Name: 'name', Value: attributes.name });
        if (attributes.email_verified !== undefined) {
            userAttributes.push({ Name: 'email_verified', Value: String(attributes.email_verified) });
        }

        if (userAttributes.length === 0) {
            return true;
        }

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
// 5. SET USER STATUS (ENABLE/DISABLE)
// ==========================================================
const setUserStatus = async (username, enabled) => {
    try {
        console.log(`🔧 Setting user status for ${username}: ${enabled ? 'ENABLED' : 'DISABLED'}`);
        
        if (enabled) {
            // Enable the user
            const params = {
                UserPoolId: USER_POOL_ID,
                Username: username
            };
            await cognito.adminEnableUser(params).promise();
            console.log('✅ User enabled');
        } else {
            // Disable the user
            const params = {
                UserPoolId: USER_POOL_ID,
                Username: username
            };
            await cognito.adminDisableUser(params).promise();
            console.log('✅ User disabled');
        }
        
        return true;
    } catch (error) {
        console.error('❌ Error setting user status:', error);
        throw new Error(`Failed to ${enabled ? 'enable' : 'disable'} user: ${error.message}`);
    }
};

// ==========================================================
// 6. LIST USERS BY ROLE
// ==========================================================
const listUsersByRole = async (role) => {
    try {
        const params = {
            UserPoolId: USER_POOL_ID,
            Filter: `custom:role = "${role}"`
        };
        
        const result = await cognito.listUsers(params).promise();
        return result.Users || [];
    } catch (error) {
        console.error('Error listing users by role:', error);
        throw error;
    }
};

// ==========================================================
// 7. DELETE USER
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
// 8. CHANGE PASSWORD
// ==========================================================
const changePassword = async (username, newPassword) => {
    try {
        if (!validatePassword(newPassword)) {
            throw new Error('Password must be at least 8 characters with uppercase, lowercase, number, and special character');
        }

        const params = {
            UserPoolId: USER_POOL_ID,
            Username: username,
            Password: newPassword,
            Permanent: true
        };
        
        await cognito.adminSetUserPassword(params).promise();
        return true;
    } catch (error) {
        console.error('Error changing password:', error);
        throw error;
    }
};

// ==========================================================
// 9. REFRESH TOKEN - WITH SECRET_HASH SUPPORT
// ==========================================================
const refreshToken = async (email, refreshTokenValue) => {
    try {
        console.log(`🔄 Refreshing token for: ${email}`);
        
        // Calculate SECRET_HASH if client secret exists
        const secretHash = calculateSecretHash(email, CLIENT_ID, CLIENT_SECRET);
        
        const authParameters = {
            REFRESH_TOKEN: refreshTokenValue
        };
        
        // Add SECRET_HASH if it exists
        if (secretHash) {
            authParameters.SECRET_HASH = secretHash;
        }
        
        const params = {
            AuthFlow: 'REFRESH_TOKEN_AUTH',
            ClientId: CLIENT_ID,
            AuthParameters: authParameters
        };
        
        const result = await cognito.initiateAuth(params).promise();
        
        console.log('✅ Token refreshed successfully');
        
        return {
            success: true,
            accessToken: result.AuthenticationResult.AccessToken,
            idToken: result.AuthenticationResult.IdToken
        };
    } catch (error) {
        console.error('❌ Token refresh error:', error);
        throw new Error(`Token refresh failed: ${error.message}`);
    }
};

// ==========================================================
// 10. PASSWORD VALIDATION
// ==========================================================
const validatePassword = (password) => {
    // Cognito default password policy:
    // - At least 8 characters
    // - Contains uppercase
    // - Contains lowercase
    // - Contains number
    // - Contains special character
    
    if (!password || password.length < 8) return false;
    
    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasSpecialChar = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);
    
    return hasUpperCase && hasLowerCase && hasNumber && hasSpecialChar;
};

// ==========================================================
// 11. JWT TOKEN UTILITIES
// ==========================================================
const verifyToken = (token) => {
    try {
        if (!token) return null;
        
        // Remove 'Bearer ' prefix if present
        const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token;
        
        const decoded = jwt.verify(cleanToken, process.env.JWT_SECRET);
        return decoded;
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

// ==========================================================
// 12. VERIFY COGNITO ACCESS TOKEN
// ==========================================================
const verifyCognitoToken = async (accessToken) => {
    try {
        const params = {
            AccessToken: accessToken
        };
        
        const result = await cognito.getUser(params).promise();
        
        // Parse user attributes
        const attributes = {};
        if (result.UserAttributes) {
            result.UserAttributes.forEach(attr => {
                attributes[attr.Name] = attr.Value;
            });
        }
        
        return {
            username: result.Username,
            email: attributes.email,
            name: attributes.name,
            email_verified: attributes.email_verified === 'true'
        };
    } catch (error) {
        console.error('Error verifying Cognito token:', error);
        throw new Error('Invalid or expired token');
    }
};

// ==========================================================
// EXPORTS
// ==========================================================
module.exports = {
    createUser,
    authenticateUser,
    getUser,
    updateUser,
    setUserStatus,
    listUsersByRole,
    deleteUser,
    changePassword,
    refreshToken,           // ✅ NEW: Refresh token with SECRET_HASH
    validatePassword,
    verifyToken,
    generateToken,
    verifyCognitoToken,     // ✅ NEW: Verify Cognito access token
    calculateSecretHash     // ✅ NEW: Export for external use if needed
};
