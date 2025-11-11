// src/utils/dynamodb.js - DynamoDB Helper Functions
const AWS = require('aws-sdk');

// Configure AWS SDK
AWS.config.update({
    region: process.env.REGION || 'ap-south-1'
});

const dynamodb = new AWS.DynamoDB.DocumentClient();

// Helper function to generate unique ID
const generateId = () => {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
};

// Helper function to get current timestamp
const timestamp = () => Math.floor(Date.now() / 1000);

// Get item from DynamoDB
const getItem = async (tableName, key) => {
    try {
        const params = {
            TableName: tableName,
            Key: key
        };
        const result = await dynamodb.get(params).promise();
        return result.Item || null;
    } catch (error) {
        console.error(`Error getting item from ${tableName}:`, error);
        throw error;
    }
};

// Put item to DynamoDB
const putItem = async (tableName, item) => {
    try {
        const params = {
            TableName: tableName,
            Item: item
        };
        await dynamodb.put(params).promise();
        return item;
    } catch (error) {
        console.error(`Error putting item to ${tableName}:`, error);
        throw error;
    }
};

// Update item in DynamoDB
const updateItem = async (tableName, key, updates) => {
    try {
        // Build update expression
        const updateExpressions = [];
        const expressionAttributeNames = {};
        const expressionAttributeValues = {};
        
        Object.keys(updates).forEach((field, index) => {
            const attrName = `#attr${index}`;
            const attrValue = `:val${index}`;
            updateExpressions.push(`${attrName} = ${attrValue}`);
            expressionAttributeNames[attrName] = field;
            expressionAttributeValues[attrValue] = updates[field];
        });
        
        const params = {
            TableName: tableName,
            Key: key,
            UpdateExpression: `SET ${updateExpressions.join(', ')}`,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: 'ALL_NEW'
        };
        
        const result = await dynamodb.update(params).promise();
        return result.Attributes;
    } catch (error) {
        console.error(`Error updating item in ${tableName}:`, error);
        throw error;
    }
};

// Delete item from DynamoDB
const deleteItem = async (tableName, key) => {
    try {
        const params = {
            TableName: tableName,
            Key: key
        };
        await dynamodb.delete(params).promise();
        return true;
    } catch (error) {
        console.error(`Error deleting item from ${tableName}:`, error);
        throw error;
    }
};

// Query items using GSI
const queryByIndex = async (tableName, indexName, keyCondition, filterExpression = null) => {
    try {
        const params = {
            TableName: tableName,
            IndexName: indexName,
            KeyConditionExpression: keyCondition.expression,
            ExpressionAttributeNames: keyCondition.names || {},
            ExpressionAttributeValues: keyCondition.values || {}
        };
        
        if (filterExpression) {
            params.FilterExpression = filterExpression.expression;
            Object.assign(params.ExpressionAttributeNames, filterExpression.names || {});
            Object.assign(params.ExpressionAttributeValues, filterExpression.values || {});
        }
        
        const result = await dynamodb.query(params).promise();
        return result.Items || [];
    } catch (error) {
        console.error(`Error querying ${tableName} by index ${indexName}:`, error);
        throw error;
    }
};

// Scan table with optional filter
const scanTable = async (tableName, filterExpression = null, limit = null) => {
    try {
        const params = {
            TableName: tableName
        };
        
        if (filterExpression) {
            params.FilterExpression = filterExpression.expression;
            params.ExpressionAttributeNames = filterExpression.names || {};
            params.ExpressionAttributeValues = filterExpression.values || {};
        }
        
        if (limit) {
            params.Limit = limit;
        }
        
        const result = await dynamodb.scan(params).promise();
        return result.Items || [];
    } catch (error) {
        console.error(`Error scanning ${tableName}:`, error);
        throw error;
    }
};

// Batch get items
const batchGetItems = async (tableName, keys) => {
    try {
        if (keys.length === 0) return [];
        
        const params = {
            RequestItems: {
                [tableName]: {
                    Keys: keys
                }
            }
        };
        
        const result = await dynamodb.batchGet(params).promise();
        return result.Responses[tableName] || [];
    } catch (error) {
        console.error(`Error batch getting items from ${tableName}:`, error);
        throw error;
    }
};

// Batch write items (put/delete)
const batchWriteItems = async (tableName, items, operation = 'put') => {
    try {
        if (items.length === 0) return true;
        
        // DynamoDB batch write limit is 25 items
        const chunks = [];
        for (let i = 0; i < items.length; i += 25) {
            chunks.push(items.slice(i, i + 25));
        }
        
        for (const chunk of chunks) {
            const requests = chunk.map(item => {
                if (operation === 'put') {
                    return { PutRequest: { Item: item } };
                } else if (operation === 'delete') {
                    return { DeleteRequest: { Key: item } };
                }
            });
            
            const params = {
                RequestItems: {
                    [tableName]: requests
                }
            };
            
            await dynamodb.batchWrite(params).promise();
        }
        
        return true;
    } catch (error) {
        console.error(`Error batch writing items to ${tableName}:`, error);
        throw error;
    }
};

// Increment numeric field
const incrementField = async (tableName, key, field, amount = 1) => {
    try {
        const params = {
            TableName: tableName,
            Key: key,
            UpdateExpression: 'SET #field = if_not_exists(#field, :zero) + :amount',
            ExpressionAttributeNames: {
                '#field': field
            },
            ExpressionAttributeValues: {
                ':amount': amount,
                ':zero': 0
            },
            ReturnValues: 'ALL_NEW'
        };
        
        const result = await dynamodb.update(params).promise();
        return result.Attributes;
    } catch (error) {
        console.error(`Error incrementing field in ${tableName}:`, error);
        throw error;
    }
};

module.exports = {
    dynamodb,
    generateId,
    timestamp,
    getItem,
    putItem,
    updateItem,
    deleteItem,
    queryByIndex,
    scanTable,
    batchGetItems,
    batchWriteItems,
    incrementField
};
