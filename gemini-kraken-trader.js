import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import KrakenFuturesApi from './krakenApi.js';
import 'dotenv/config';

// --- Configuration ---
const KRAKEN_API_KEY = process.env.KRAKEN_API_KEY;
const KRAKEN_API_SECRET = process.env.KRAKEN_API_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET || !GEMINI_API_KEY) {
    console.error("Error: Missing required environment variables.");
    process.exit(1);
}

// --- Initialize Clients ---
const krakenClient = new KrakenFuturesApi(KRAKEN_API_KEY, KRAKEN_API_SECRET);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// --- Tool Definitions for Gemini ---
const tools = [
    {
        name: 'getHistoricPriceData',
        description: 'Fetches historical OHLC price data for a trading pair.',
        parameters: { type: SchemaType.OBJECT, properties: { pair: { type: SchemaType.STRING }, interval: { type: SchemaType.NUMBER } }, required: ['pair', 'interval'] }
    },
    {
        name: 'getAvailableMargin',
        description: 'Retrieves the trading account\'s available margin and balance.',
        parameters: { type: SchemaType.OBJECT, properties: {}, required: [] }
    },
    {
        name: 'getOpenPositions',
        description: 'Fetches all currently open positions.',
        parameters: { type: SchemaType.OBJECT, properties: {}, required: [] }
    },
    {
        name: 'getOpenOrders',
        description: 'Retrieves a list of all open (unfilled) orders.',
        parameters: { type: SchemaType.OBJECT, properties: {}, required: [] }
    },
    {
        name: 'cancelOrder',
        description: 'Cancels a specific open order by its ID.',
        parameters: { type: SchemaType.OBJECT, properties: { order_id: { type: SchemaType.STRING } }, required: ['order_id'] }
    },
    {
        name: 'hold',
        description: 'Pauses execution for a specified number of seconds.',
        parameters: { type: SchemaType.OBJECT, properties: { duration: { type: SchemaType.NUMBER } }, required: ['duration'] }
    },
    {
        name: 'provideAnalysis',
        description: 'Call this function last to provide the final analysis based on the data from the other function calls.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                summary: { type: SchemaType.STRING, description: 'The final summary of the market and account status.' }
            },
            required: ['summary']
        }
    }
];

// --- Tool Implementation (Registry) ---
const registry = {
    getHistoricPriceData: (params) => krakenClient.getHistory(params),
    getAvailableMargin: () => krakenClient.getAccounts(),
    getOpenPositions: () => krakenClient.getOpenPositions(),
    getOpenOrders: () => krakenClient.getOpenOrders(),
    cancelOrder: (params) => krakenClient.cancelOrder(params),
    hold: (params) => new Promise(resolve => {
        console.log(`Holding for ${params.duration} seconds...`);
        setTimeout(() => resolve(`Held for ${params.duration} seconds.`), params.duration * 1000);
    }),
    provideAnalysis: (params) => {
        console.log("\n--- Gemini's Final Analysis ---");
        console.log(params.summary);
    }
};

// --- Main Execution Logic (Single Request, Multiple Function Calls) ---
(async () => {
    console.log("--- Starting Gemini Trading Bot (Non-Looping Architecture) ---");

    // **CRUCIAL**: The prompt asks Gemini to plan all its function calls at once.
    const prompt = `
        You are an autonomous trading analyst. Your task is to gather information about a trading account, analyze it, and provide a summary.
        
        **Execution Plan:**
        1. First, call \`getHistoricPriceData\` for the 'PI_XBTUSD' pair with a 60-minute interval.
        2. Second, call \`getAvailableMargin\`.
        3. Third, call \`getOpenPositions\`.
        4. Finally, after planning the previous calls, call the \`provideAnalysis\` function with a concise summary of the market and account status.
        
        You must schedule all of these function calls in a single response.
    `;

    try {
        const chat = model.startChat({ tools: [{ functionDeclarations: tools }] });
        
        console.log("Sending a single request to Gemini to get the execution plan...");
        const result = await chat.sendMessage(prompt);

        const calls = result.response.functionCalls();

        if (!calls || calls.length === 0) {
            console.log("Gemini did not return any function calls. It may have responded with text instead:");
            console.log(result.response.text());
            return;
        }

        console.log(`\nGemini returned a plan with ${calls.length} steps. Executing locally...`);

        // This is a simple, finite loop over the results of a SINGLE API call.
        for (const call of calls) {
            console.log(`\nExecuting step: ${call.name}(${JSON.stringify(call.args)})`);
            if (registry[call.name]) {
                // We don't need the result of the functions for this pattern, just to execute them.
                await registry[call.name](call.args);
            } else {
                console.warn(`Warning: Unknown tool '${call.name}' requested.`);
            }
        }

        console.log("\n--- Script execution finished successfully. ---");

    } catch (error) {
        console.error("\n--- A critical error occurred ---");
        console.error(error.message);
        if (error.message.includes('429')) {
             console.error("This indicates a rate limit issue, which is unexpected with this architecture. Please check your Google Cloud project's billing status and API quotas.");
        }
    }
})();
