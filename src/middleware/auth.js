// src/middleware/auth.js
const { verifyToken: verifyJwt } = require('../utils/cognito'); // Import the JWT verifier
const { getItem } = require('../utils/dynamodb');

/**
 * Main authentication middleware.
 * Verifies the JWT and attaches user info to req.user.
 */
const verifyToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized'
            });
        }
        
        const token = authHeader.split(' ')[1];
        const decoded = verifyJwt(token); // Use the function from cognito.js
        
        if (!decoded) {
            return res.status(401).json({
                success: false,
                error: 'Invalid or expired token'
            });
        }
        
        // Attach decoded token data to the request
        req.user = decoded; 
        next();
        
    } catch (error) {
        return res.status(401).json({
            success: false,
            error: 'Authentication failed'
        });
    }
};

/**
 * Role-checking middleware.
 * Use this *after* verifyToken.
 */
const requireRole = (roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Access denied. You do not have the required permissions.'
            });
        }
        next();
    };
};

module.exports = {
    verifyToken,
    requireRole
};
