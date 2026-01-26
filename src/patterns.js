// BSN Validation (Dutch 11-check)
export function isValidBSN(bsn) {
    const digits = bsn.padStart(9, '0');
    if (digits.length !== 9 || !/^\d{9}$/.test(digits)) return false;

    const weights = [9, 8, 7, 6, 5, 4, 3, 2, -1];
    let sum = 0;
    for (let i = 0; i < 9; i++) {
        sum += parseInt(digits[i]) * weights[i];
    }
    return sum % 11 === 0 && digits !== '000000000';
}

// Pattern definitions
export const PATTERNS = {
    '<bsn>': {
        regex: /\b\d{8,9}\b/g,
        validate: (match) => isValidBSN(match),
        description: 'Dutch BSN numbers'
    },
    '<email>': {
        regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
        validate: () => true,
        description: 'Email addresses'
    },
    '<phone>': {
        regex: /\b(?:\+31|0)[\s.-]?(?:\d[\s.-]?){9}\b/g,
        validate: () => true,
        description: 'Dutch phone numbers'
    },
    '<iban>': {
        regex: /\b[A-Z]{2}\d{2}[A-Z]{4}\d{10}\b/g,
        validate: () => true,
        description: 'IBAN numbers'
    },
    '<date>': {
        regex: /\b\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4}\b/g,
        validate: () => true,
        description: 'Dates (DD-MM-YYYY, etc.)'
    },
    '<postcode>': {
        regex: /\b\d{4}\s?[A-Z]{2}\b/gi,
        validate: () => true,
        description: 'Dutch postcodes'
    }
};

// Get all pattern keys
export function getPatternKeys() {
    return Object.keys(PATTERNS);
}

// Check if a term is a pattern
export function isPattern(term) {
    return term in PATTERNS;
}
