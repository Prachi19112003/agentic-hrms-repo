const fs = require('fs');
const path = require('path');
const https = require('https');

// Initialize local environment variables from .env / .env.local
function initEnv() {
    const envData = {};
    function parseFile(envPath) {
        if (fs.existsSync(envPath)) {
            try {
                const content = fs.readFileSync(envPath, 'utf8');
                for (let line of content.split('\n')) {
                    line = line.trim();
                    if (!line || line.startsWith('#')) continue;
                    const idx = line.indexOf('=');
                    if (idx !== -1) {
                        const key = line.substring(0, idx).trim();
                        let val = line.substring(idx + 1).trim();
                        if (key) {
                            envData[key] = val;
                        }
                    }
                }
            } catch (e) {}
        }
    }

    // Load in order of increasing priority
    const possiblePaths = [
        path.join(process.cwd(), '.env'),
        path.join(__dirname, '..', '.env'),
        path.join(process.cwd(), '.env.local'),
        path.join(__dirname, '..', '.env.local')
    ];
    possiblePaths.forEach(parseFile);

    // Apply to process.env if not already set by the OS/hosting provider
    for (const [key, val] of Object.entries(envData)) {
        if (!process.env[key]) {
            process.env[key] = val;
        }
    }
}

// Clean API key string from quotes and angle brackets
function sanitizeApiKey(key) {
    if (!key || typeof key !== 'string') return '';
    let val = key.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1).trim();
    }
    if (val.startsWith('<') && val.endsWith('>')) {
        val = val.slice(1, -1).trim();
    }
    return val;
}

// Helper to search for employee_model.json across multiple potential directories
function findSchemaPath() {
    const paths = [
        path.join(process.cwd(), 'employee_model.json'),
        path.join(process.cwd(), '..', 'employee_model.json'),
        path.join(__dirname, 'employee_model.json'),
        path.join(__dirname, '..', 'employee_model.json'),
        path.join(__dirname, '..', '..', 'employee_model.json')
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    throw new Error("Critical Error: employee_model.json could not be found in local paths.");
}

// Helper to count structural complex fields in the schema properties
function countComplexFields(schema) {
    const targetDict = schema.properties || schema;
    let count = 0;
    for (const val of Object.values(targetDict)) {
        if (val && (typeof val === 'object' || Array.isArray(val))) {
            count++;
        }
    }
    return count;
}

// Helper to strip markdown formatting blocks from AI text response
function cleanJsonResponse(content) {
    content = content.strip ? content.strip() : content.trim();
    if (content.startsWith("```")) {
        const firstNewline = content.indexOf("\n");
        if (firstNewline !== -1) {
            content = content.substring(firstNewline).trim();
        }
        if (content.endsWith("```")) {
            content = content.substring(0, content.length - 3).trim();
        }
    }
    return content;
}

// Data-level validation rules for schema integrity
function validateDataLevel(schema) {
    let validationResult = { valid: true };

    function traverse(obj, currentPath = '') {
        if (!obj || typeof obj !== 'object') return;

        if (obj.properties) {
            for (const [key, propVal] of Object.entries(obj.properties)) {
                const newPath = currentPath ? `${currentPath}.${key}` : key;
                
                // Rule A: employee_id validation pattern match
                if (key.toLowerCase().includes('employee_id')) {
                    if (!propVal.pattern || propVal.pattern !== '^EMP-[A-Z]{3,4}-\\d{5,8}$') {
                        validationResult = {
                            valid: false,
                            error: `Field '${newPath}' must define a validation pattern matching '^EMP-[A-Z]{3,4}-\\d{5,8}$'. Found: '${propVal.pattern || 'none'}'`
                        };
                        return;
                    }
                }

                // Rule B: prevent self-allocation and empty fields
                if (propVal.properties) {
                    const subKeys = Object.keys(propVal.properties);
                    const hasIssuedBy = subKeys.includes('issued_by') || subKeys.includes('allotted_by');
                    const hasIssuedTo = subKeys.includes('issued_to') || subKeys.includes('allotted_to');
                    
                    if (hasIssuedBy && hasIssuedTo) {
                        const byField = subKeys.includes('issued_by') ? 'issued_by' : 'allotted_by';
                        const toField = subKeys.includes('issued_to') ? 'issued_to' : 'allotted_to';
                        
                        // Check if fields are empty / not required
                        const required = propVal.required || [];
                        if (!required.includes(byField) || !required.includes(toField)) {
                            validationResult = {
                                valid: false,
                                error: `Allocation object '${newPath}' must list both '${byField}' and '${toField}' as required to prevent empty fields.`
                            };
                            return;
                        }

                        // Enforce description rule against self-allocation
                        const byDesc = (propVal.properties[byField].description || '').toLowerCase();
                        const toDesc = (propVal.properties[toField].description || '').toLowerCase();
                        if (!byDesc.includes('different') && !toDesc.includes('different') && 
                            !byDesc.includes('cannot be the same') && !toDesc.includes('cannot be the same')) {
                            validationResult = {
                                valid: false,
                                error: `Allocation object '${newPath}' must specify constraint rules in description to prevent self-allocation (e.g. 'Must be different than ${toField}').`
                            };
                            return;
                        }
                    }
                }

                traverse(propVal, newPath);
            }
        }
        
        if (obj.items) {
            traverse(obj.items, currentPath ? `${currentPath}.items` : 'items');
        }
    }

    traverse(schema);
    return validationResult;
}

// Call Gemini generateContent API via Node HTTPS
function callGeminiAPI(apiKey, schemaContent, requirement) {
    const payload = {
        contents: [
            {
                role: "user",
                parts: [{ text: `Existing Schema:\n${schemaContent}\n\nRequirement:\n${requirement}` }]
            }
        ],
        systemInstruction: {
            parts: [{ text: "You are an autonomous AI Engineer. Update the given HRMS JSON schema based on the requirement. Return ONLY valid JSON with no markdown, no explanation. Just the raw updated JSON object. Ensure that if any ID or allocation fields are added, they conform to strict HRMS requirements (e.g. employee_id pattern must be '^EMP-[A-Z]{3,4}-\\d{5,8}$', and allocation objects must require both assigner and assignee, with descriptions preventing self-allocation)." }]
        },
        generationConfig: {
            responseMimeType: "application/json"
        }
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(payload);
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr)
            }
        };

        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Gemini API returned status ${res.statusCode}: ${data}`));
                } else {
                    try {
                        const parsed = JSON.parse(data);
                        if (!parsed.candidates || parsed.candidates.length === 0) {
                            reject(new Error("No candidates returned from Gemini API. Check API configuration/quota."));
                            return;
                        }
                        const text = parsed.candidates[0].content.parts[0].text;
                        resolve(text);
                    } catch (e) {
                        reject(new Error(`Failed to parse Gemini response: ${e.message}. Raw: ${data}`));
                    }
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.write(bodyStr);
        req.end();
    });
}

// Serverless Function handler
module.exports = async (req, res) => {
    // CORS configuration
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method === 'GET') {
        try {
            const schemaPath = findSchemaPath();
            const schemaContent = fs.readFileSync(schemaPath, 'utf8');
            return res.status(200).json({
                status: 'success',
                schema: JSON.parse(schemaContent)
            });
        } catch (e) {
            return res.status(500).json({ status: 'error', message: e.message });
        }
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ status: 'error', message: 'Method Not Allowed' });
    }

    try {
        const { requirement } = req.body;
        if (!requirement) {
            return res.status(400).json({ status: 'error', message: 'Missing requirement parameter.' });
        }

        initEnv();
        const rawApiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
        if (!rawApiKey) {
            return res.status(500).json({ status: 'error', message: 'Server configuration error: GOOGLE_API_KEY or GEMINI_API_KEY environment variable is missing.' });
        }
        const apiKey = sanitizeApiKey(rawApiKey);

        // 1. Read existing schema
        let schemaPath;
        try {
            schemaPath = findSchemaPath();
        } catch (e) {
            return res.status(500).json({ status: 'error', message: e.message });
        }

        const beforeSchemaContent = fs.readFileSync(schemaPath, 'utf8');
        const beforeSchema = JSON.parse(beforeSchemaContent);

        // 2. Call Gemini
        let responseText;
        try {
            console.log("GOOGLE_API_KEY length:", process.env.GOOGLE_API_KEY ? process.env.GOOGLE_API_KEY.length : "undefined");
            console.log("GEMINI_API_KEY length:", process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.length : "undefined");
            console.log("Resolved and Cleaned API Key length:", apiKey ? apiKey.length : "undefined");
            responseText = await callGeminiAPI(apiKey, beforeSchemaContent, requirement);
        } catch (e) {
            return res.status(502).json({ status: 'error', message: `Upstream AI Engine Error: ${e.message}` });
        }

        // 3. Clean and parse
        let afterSchema;
        const cleanedText = cleanJsonResponse(responseText);
        try {
            afterSchema = JSON.parse(cleanedText);
        } catch (e) {
            return res.status(422).json({ status: 'error', message: `AI output failed syntax validation: ${e.message}. Cleaned response: ${cleanedText}` });
        }

        // 4. Validate complexity
        const complexCount = countComplexFields(afterSchema);
        if (complexCount < 5) {
            return res.status(422).json({
                status: 'error',
                message: `Complexity Validation Error: Found only ${complexCount} top-level fields. Enterprise schema requires at least 5 nested fields.`
            });
        }

        // 5. Data-level validations
        const dataVal = validateDataLevel(afterSchema);
        if (!dataVal.valid) {
            return res.status(422).json({
                status: 'error',
                message: `Business Rule Validation Failed: ${dataVal.error}`
            });
        }

        // 6. Save back to file
        fs.writeFileSync(schemaPath, JSON.stringify(afterSchema, null, 2), 'utf8');

        return res.status(200).json({
            status: 'success',
            before: beforeSchema,
            after: afterSchema,
            message: 'Schema successfully updated, validated, and saved to repository.'
        });

    } catch (error) {
        console.error("Unhanled API Error:", error);
        return res.status(500).json({
            status: 'error',
            message: `Internal Server Error: ${error.message}`
        });
    }
};
