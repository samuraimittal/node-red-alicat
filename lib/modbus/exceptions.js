'use strict';

/** Modbus exception codes (Modbus Application Protocol v1.1b3, §7). */
const EXCEPTIONS = Object.freeze({
    1: 'ILLEGAL_FUNCTION',
    2: 'ILLEGAL_DATA_ADDRESS',
    3: 'ILLEGAL_DATA_VALUE',
    4: 'SERVER_DEVICE_FAILURE',
    5: 'ACKNOWLEDGE',
    6: 'SERVER_DEVICE_BUSY',
    8: 'MEMORY_PARITY_ERROR',
    10: 'GATEWAY_PATH_UNAVAILABLE',
    11: 'GATEWAY_TARGET_FAILED_TO_RESPOND'
});

const ILLEGAL_FUNCTION = 1;
const ILLEGAL_DATA_ADDRESS = 2;
const ILLEGAL_DATA_VALUE = 3;
const SERVER_DEVICE_FAILURE = 4;
const SERVER_DEVICE_BUSY = 6;

/** @param {number} code */
function exceptionName(code) {
    return EXCEPTIONS[/** @type {keyof typeof EXCEPTIONS} */ (code)] || `UNKNOWN_EXCEPTION_${code}`;
}

module.exports = {
    EXCEPTIONS,
    ILLEGAL_FUNCTION,
    ILLEGAL_DATA_ADDRESS,
    ILLEGAL_DATA_VALUE,
    SERVER_DEVICE_FAILURE,
    SERVER_DEVICE_BUSY,
    exceptionName
};
