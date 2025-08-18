import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import KrakenFuturesApi from './krakenApi.js';
import 'dotenv/config';

// --- Configuration ---
const KRAKEN_API_KEY = process.env.KRAKEN_API_KEY;
const KRAKEN_API_SECRET = process.env.KRAKEN_API_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const REQUEST_DELAY_MS = 1500; // Delay between recursive calls to prevent rate limiting.

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
    console.log("Starting Gemini Trading Bot...");
    const chat = model.startChat({ tools: [{ functionDeclarations: tools }] });

    const prompt = `
        You are an autonomous trading AI. Your goal is to grow the account balance by executing a trading strategy.
        1.  Analyze the current market by fetching historical price data for 'PI_XBTUSD' on a 60-minute interval.
        2.  Check the available margin and any open positions or orders.
        3.  Based on your analysis, decide on a trading action. You can place new orders, cancel existing ones, or hold.
        4.  For now, your primary task is to analyze and report. Do not place an order yet.
        5.  Explain your reasoning and the data you've gathered.
        6.  If there are any open orders you deem unnecessary, cancel one of them.
        7.  Conclude by holding for 10 seconds and then provide a final summary of your actions.
    `;

    let initialResult = await chat.sendMessage(prompt);
    
    // **NEW**: Recursive function to handle the conversation flow.
    async function handleResponse(result, iteration = 1) {
        console.log(`\n--- Conversation Turn: ${iteration} ---`);

        const calls = result.response.functionCalls();
        
        // **Exit Condition**: If there are no more function calls, print the final text and stop.
        if (!calls || calls.length === 0) {
            console.log("--- Conversation End: No more function calls from Gemini. ---");
            console.log("Inspecting Final Response Object:");
            console.log(JSON.stringify(result.response, null, 2));
            
            const finalText = result.response.text();
            if (finalText) {
                console.log("\nGemini's Final Summary:");
                console.log(finalText);
            } else {
                console.log("\nGemini's final response was empty.");
            }
            return; // End recursion
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
            } else {
                console.warn(`Warning: Unknown tool '${toolName}' requested by Gemini.`);
            }
        }

        // Add a delay before sending the response back to Gemini
        console.log(`\nWaiting for ${REQUEST_DELAY_MS}ms before sending results...`);
        await delay(REQUEST_DELAY_MS);

        console.log("\n--- Sending Tool Responses to Gemini ---");
        console.log(JSON.stringify(toolResponses, null, 2));
        
        // Send results back to Gemini and recurse
        const nextResult = await chat.sendMessage(JSON.stringify(toolResponses));
        await handleResponse(nextResult, iteration + 1);
    }

    // Start the recursive conversation handler
    await handleResponse(initialResult);
}

// Run the main function
runConversation().catch(console.error);
