import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import KrakenFuturesApi from './krakenApi.js';
import 'dotenv/config';

// --- Configuration ---
const KRAKEN_API_KEY = process.env.KRAKEN_API_KEY;
const KRAKEN_API_SECRET = process.env.KRAKEN_API_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- Timeout Configurations ---
const REQUEST_DELAY_MS = 1500;       // 1. Delay between each loop iteration.
const FUNCTION_EXEC_TIMEOUT_MS = 10000; // 2. Max time for a single Kraken API call (10 seconds).
const MASTER_TIMEOUT_MS = 180000;     // 3. Max total runtime for the script (3 minutes).

if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET || !GEMINI_API_KEY) {
    console.error("Error: Missing required environment variables (KRAKEN_API_KEY, KRAKEN_API_SECRET, GEMINI_API_KEY).");
    process.exit(1);
}

// --- Utility Functions ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wraps a promise with a timeout.
 * @param {Promise} promise The promise to execute.
 * @param {number} timeout The timeout in milliseconds.
 * @param {string} toolName The name of the tool for error logging.
 * @returns {Promise}
 */
function withTimeout(promise, timeout, toolName) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Tool '${toolName}' timed out after ${timeout}ms`));
        }, timeout);

        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

// --- Initialize Clients ---
const krakenClient = new KrakenFuturesApi(KRAKEN_API_KEY, KRAKEN_API_SECRET);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// --- Tool Definitions (unchanged) ---
const tools = [
    { name: 'getHistoricPriceData', description: 'Fetches historical OHLC price data.', parameters: { type: SchemaType.OBJECT, properties: { pair: { type: SchemaType.STRING }, interval: { type: SchemaType.NUMBER } }, required: ['pair', 'interval'] } },
    { name: 'getAvailableMargin', description: 'Retrieves available margin.', parameters: { type: SchemaType.OBJECT, properties: {}, required: [] } },
    { name: 'getOpenPositions', description: 'Fetches open positions.', parameters: { type: SchemaType.OBJECT, properties: {}, required: [] } },
    { name: 'getOpenOrders', description: 'Retrieves open orders.', parameters: { type: SchemaType.OBJECT, properties: {}, required: [] } },
    { name: 'cancelOrder', description: 'Cancels a specific order.', parameters: { type: SchemaType.OBJECT, properties: { order_id: { type: SchemaType.STRING } }, required: ['order_id'] } },
    { name: 'hold', description: 'Pauses execution.', parameters: { type: SchemaType.OBJECT, properties: { duration: { type: SchemaType.NUMBER } }, required: ['duration'] } }
];

// --- Tool Implementation (Registry) ---
const registry = {
    getHistoricPriceData: (params) => krakenClient.getHistory(params),
    getAvailableMargin: () => krakenClient.getAccounts(),
    getOpenPositions: () => krakenClient.getOpenPositions(),
    getOpenOrders: () => krakenClient.getOpenOrders(),
    cancelOrder: (params) => krakenClient.cancelOrder(params),
    hold: (params) => delay(params.duration * 1000).then(() => `Held for ${params.duration} seconds.`)
};

// --- Main Execution Logic ---
async function main() {
    console.log("Starting Gemini Trading Bot with multi-layered timeouts...");

    const prompt = `
        You are an autonomous trading AI. Your goal is to grow the account balance.
        1. Fetch historical price data for 'PI_XBTUSD' (60-minute interval).
        2. Check available margin and any open positions or orders.
        3. Analyze the data and explain your reasoning.
        4. If any open orders seem unnecessary, cancel one.
        5. Conclude by holding for 10 seconds and then provide a final summary.
    `;

    const chat = model.startChat({ tools: [{ functionDeclarations: tools }] });
    let result = await chat.sendMessage(prompt);
    let loopCount = 0;

    while (true) {
        loopCount++;
        console.log(`\n--- Loop Iteration: ${loopCount} ---`);

        const calls = result.response.functionCalls();
        if (!calls || calls.length === 0) {
            console.log("Loop Exit Condition: No function calls returned by Gemini.");
            const finalText = result.response.text();
            console.log(finalText ? `Gemini's final response:\n${finalText}` : "Gemini's final response was empty.");
            break;
        }

        console.log(`Gemini wants to call ${calls.length} function(s):`);
        const toolResponses = [];

        for (const call of calls) {
            const toolName = call.name;
            if (registry[toolName]) {
                console.log(`Executing: ${toolName}(${JSON.stringify(call.args)})`);
                try {
                    // **TIMEOUT 2**: Each function call is wrapped in its own timeout.
                    const apiResult = await withTimeout(
                        registry[toolName](call.args),
                        FUNCTION_EXEC_TIMEOUT_MS,
                        toolName
                    );
                    toolResponses.push({ functionName: toolName, response: { result: apiResult } });
                } catch (error) {
                    console.error(`Error executing tool '${toolName}':`, error.message);
                    toolResponses.push({ functionName: toolName, response: { error: `Execution failed: ${error.message}` } });
                }
            } else {
                console.warn(`Warning: Unknown tool '${toolName}' requested by Gemini.`);
            }
        }

        console.log("\n--- Sending Tool Responses to Gemini ---");
        console.log(JSON.stringify(toolResponses, null, 2));

        result = await chat.sendMessage(JSON.stringify(toolResponses));
        
        // **TIMEOUT 1**: A controlled delay at the end of every loop.
        console.log(`\nWaiting for ${REQUEST_DELAY_MS}ms before next iteration...`);
        await delay(REQUEST_DELAY_MS);
    }
}

// **TIMEOUT 3**: Master timeout for the entire script.
Promise.race([
    main(),
    new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Master script timeout reached after ${MASTER_TIMEOUT_MS / 1000} seconds.`)), MASTER_TIMEOUT_MS)
    )
]).catch(error => {
    console.error(`\n--- SCRIPT HALTED ---`);
    console.error(error.message);
    process.exit(1);
});
