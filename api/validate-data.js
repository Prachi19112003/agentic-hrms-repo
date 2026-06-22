module.exports = async (req, res) => {
    // CORS configuration
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ status: 'error', message: 'Method Not Allowed' });
    }

    try {
        const { fieldName, data, schema } = req.body;
        if (!fieldName || !data || !schema) {
            return res.status(400).json({ status: 'error', message: 'Missing parameters (fieldName, data, schema).' });
        }

        const requiredFields = schema.required || [];
        const schemaProps = schema.properties || {};

        // 1. Check all required fields are filled in
        const missingFields = [];
        for (const reqField of requiredFields) {
            if (data[reqField] === undefined || data[reqField] === null || String(data[reqField]).trim() === '') {
                missingFields.push(reqField);
            }
        }
        if (missingFields.length > 0) {
            return res.status(422).json({
                status: 'error',
                message: `Required field validation failed: Missing fields [${missingFields.join(', ')}]`
            });
        }

        // 2. Validate employee_id format
        for (const [key, value] of Object.entries(data)) {
            if (key.toLowerCase().includes('employee_id')) {
                const regex = /^EMP-[A-Z]{3,4}-\d{5,8}$/;
                if (!regex.test(value)) {
                    return res.status(422).json({
                        status: 'error',
                        message: `Invalid Employee ID format - expected EMP-XXX-12345 style, got: '${value}'`
                    });
                }
            }
        }

        // 3. Validate self-allocation for paired fields
        const keys = Object.keys(data);
        const hasIssuedBy = keys.includes('issued_by') || keys.includes('allotted_by');
        const hasIssuedTo = keys.includes('issued_to') || keys.includes('allotted_to');
        if (hasIssuedBy && hasIssuedTo) {
            const byField = keys.includes('issued_by') ? 'issued_by' : 'allotted_by';
            const toField = keys.includes('issued_to') ? 'issued_to' : 'allotted_to';
            
            const byValue = String(data[byField]).trim();
            const toValue = String(data[toField]).trim();
            
            if (byValue && toValue && byValue.toLowerCase() === toValue.toLowerCase()) {
                return res.status(422).json({
                    status: 'error',
                    message: "Issuer and recipient cannot be the same person"
                });
            }
        }

        return res.status(200).json({
            status: 'success',
            message: "All constraints passed - this data entry is valid"
        });

    } catch (error) {
        return res.status(500).json({ status: 'error', message: error.message });
    }
};
