import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import KrakenFuturesApi from './krakenApi.js';
import 'dotenv/config';

// --- Configuration ---
const KRAKEN_API_KEY = process.env.KRAKEN_API_KEY;
const KRAKEN_API_SECRET = process.env.KRAKEN_API_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// **CRUCIAL CHANGE**: Increased delay to respect the API's requests-per-minute limit.
// A 10-second delay allows for a maximum of 6 calls per minute, safely under the typical limit of 15.
const CONVERSATION_TURN_DELAY_MS = 10000; 

if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET || !GEMINI_API_KEY) {
    console.error("Error: Missing required environment variables (KRAKEN_API_KEY, KRAKEN_API_SECRET, GEMINI_API_KEY).");
    process.exit(1);
}

// --- Utility function for delay ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Initialize Clients ---
const krakenClient = new KrakenFuturesApi(KRAKEN_API_KEY, KRAKEN_API_SECRET);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// --- Tool Definitions for Gemini ---
const tools = [
    {
        name: 'getHistoricPriceData',
        description: 'Fetches historical OHLC (Open, High, Low, Close) price data for a given trading pair.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                pair: { type: SchemaType.STRING, description: "The trading pair, e.g., 'PI_XBTUSD'." },
                interval: { type: SchemaType.NUMBER, description: 'The time frame interval in minutes (e.g., 60 for 1 hour).' }
            },
            required: ['pair', 'interval']
        }
    },
    {
        name: 'getAvailableMargin',
        description: 'Retrieves the total available margin and balance information from the trading account.',
        parameters: { type: SchemaType.OBJECT, properties: {}, required: [] }
    },
    {
        name: 'getOpenPositions',
        description: 'Fetches all currently open positions in the trading account.',
        parameters: { type: SchemaType.OBJECT, properties: {}, required: [] }
    },
    {
        name: 'getOpenOrders',
        description: 'Retrieves a list of all currently open (unfilled) orders.',
        parameters: { type: SchemaType.OBJECT, properties: {}, required: [] }
    },
    {
        name: 'cancelOrder',
        description: 'Cancels a specific open order using its order ID.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                order_id: { type: SchemaType.STRING, description: 'The unique identifier of the order to cancel.' }
            },
            required: ['order_id']
        }
    },
    {
        name: 'hold',
        description: 'Pauses execution for a specified number of seconds to wait for market conditions to change.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                duration: { type: SchemaType.NUMBER, description: 'The duration to wait, in seconds.' }
            },
            required: ['duration']
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
    })
};

// --- Main Execution Logic (Recursive Function) ---
async function runConversation() {
    console.log("Starting Gemini Trading Bot (Recursive, Rate-Limit-Aware)...");
    const chat = model.startChat({ tools: [{ functionDeclarations: tools }] });

    const prompt = `
        You are an autonomous trading AI. Your goal is to grow the account balance by executing a trading strategy.
        1.  Analyze the current market by fetching historical price data for 'PI_XBTUSD' on a 60-minute interval.
        2.  Check the available margin and any open positions or orders.
        3.  Based on your analysis, decide on a trading action. For now, your primary task is to analyze and report. Do not place an order yet.
        4.  Explain your reasoning and the data you've gathered.
        5.  If there are any open orders you deem unnecessary, cancel one of them.
        6.  Conclude by holding for 5 seconds and then provide a final summary of your actions.
    `;

    let initialResult = await chat.sendMessage(prompt);
    
    async function handleResponse(result, iteration = 1) {
        console.log(`\n--- Conversation Turn: ${iteration} ---`);

        const calls = result.response.functionCalls();
        
        if (!calls || calls.length === 0) {
            console.log("--- Conversation End: No more function calls from Gemini. ---");
            const finalText = result.response.text();
            console.log("\nGemini's Final Summary:");
            console.log(finalText || "[No final text provided]");
            return;
        }

        console.log(`Gemini wants to call ${calls.length} function(s):`);
        const toolResponses = [];

        for (const call of calls) {
            const toolName = call.name;
            if (registry[toolName]) {
                console.log(`Executing: ${toolName}(${JSON.stringify(call.args)})`);
                try {
                    const apiResult = await registry[toolName](call.args);
                    toolResponses.push({ functionName: toolName, response: { result: apiResult } });
                } catch (error) {
                    console.error(`Error executing tool '${toolName}':`, error.message);
                    toolResponses.push({ functionName: toolName, response: { error: `Execution failed: ${error.message}` } });
                }
            }
        }

        console.log(`\nWaiting for ${CONVERSATION_TURN_DELAY_MS}ms to respect API rate limits...`);
        await delay(CONVERSATION_TURN_DELAY_MS);

        console.log("\n--- Sending Tool Responses to Gemini ---");
        const nextResult = await chat.sendMessage(JSON.stringify(toolResponses));
        await handleResponse(nextResult, iteration + 1);
    }

    await handleResponse(initialResult);
}

runConversation().catch(error => {
    console.error("\n--- An unexpected error occurred ---");
    console.error(error.message);
    // This will catch the 429 error if it still occurs, but it's much less likely now.
    if (error.message.includes('429')) {
        console.error("Recommendation: The delay between API calls may still be too short for your current API plan. Consider increasing CONVERSATION_TURN_DELAY_MS.");
    }
});
