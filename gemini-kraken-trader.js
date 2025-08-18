import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import KrakenFuturesApi from './krakenApi.js';
import 'dotenv/config';

// --- Configuration ---
const KRAKEN_API_KEY = process.env.KRAKEN_API_KEY;
const KRAKEN_API_SECRET = process.env.KRAKEN_API_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CONVERSATION_TURN_DELAY_MS = 2000; // Delay between conversational turns.

if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET || !GEMINI_API_KEY) {
    console.error("Error: Missing required environment variables.");
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
    // The explicit exit tool.
    {
        name: 'taskComplete',
        description: 'Call this function when all analysis and actions are complete. Provide the final summary as an argument.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                summary: { type: SchemaType.STRING, description: 'The final summary of all actions taken and the concluding analysis.' }
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
    // The handler for our exit tool.
    taskComplete: (params) => {
        console.log("\n--- Gemini has signaled task completion ---");
        console.log("Final Summary:\n", params.summary);
        return "Execution successfully terminated.";
    }
};

// --- Main Execution Logic (Recursive with Exit Condition) ---
async function runConversation() {
    console.log("Starting Gemini Trading Bot (Architecture with Defined Exit)...");
    const chat = model.startChat({ tools: [{ functionDeclarations: tools }] });

    // The prompt instructs the AI on how to exit.
    const prompt = `
        You are an autonomous trading AI. Your goal is to analyze the market and account, then provide a summary.
        
        **Your Task:**
        1.  Fetch historical price data for 'PI_XBTUSD' on a 60-minute interval.
        2.  Check the available margin.
        3.  Check for any open positions or orders.
        4.  Analyze all the gathered information.
        5.  If there are any open orders you deem unnecessary, cancel one.
        
        **IMPORTANT:** Once you have completed all steps and have a final analysis, you MUST call the \`taskComplete\` function with your full summary. This is your final step. Do not reply with text.
    `;

    let initialResult = await chat.sendMessage(prompt);
    
    async function handleResponse(result, iteration = 1) {
        console.log(`\n--- Conversation Turn: ${iteration} ---`);

        const calls = result.response.functionCalls();
        
        if (!calls || calls.length === 0) {
            console.log("--- Conversation End: AI provided a text response instead of calling a function. ---");
            console.log("Final Text:", result.response.text() || "[No text provided]");
            return;
        }

        console.log(`Gemini wants to call ${calls.length} function(s):`);
        
        // This version processes one function call at a time to maintain a clear conversational flow.
        const call = calls[0]; 

        // Check for the exit condition first.
        if (call.name === 'taskComplete') {
            registry.taskComplete(call.args);
            console.log("\n--- Script execution finished successfully. ---");
            return; // Exit the entire recursive chain.
        }

        if (registry[call.name]) {
            console.log(`Executing: ${call.name}(${JSON.stringify(call.args)})`);
            try {
                const apiResult = await registry[call.name](call.args);
                const toolResponse = { functionName: call.name, response: { result: apiResult } };
                
                console.log(`Waiting for ${CONVERSATION_TURN_DELAY_MS}ms...`);
                await delay(CONVERSATION_TURN_DELAY_MS);

                console.log(`\n--- Sending Tool Response to Gemini for [${call.name}] ---`);
                // Send the single tool response back and wait for the next instruction.
                const nextResult = await chat.sendMessage(JSON.stringify([toolResponse]));
                await handleResponse(nextResult, iteration + 1);

            } catch (error) {
                console.error(`Error during execution of ${call.name}:`, error.message);
                return; // Stop on error.
            }
        } else {
             console.warn(`Warning: Unknown tool '${call.name}' requested.`);
        }
    }

    await handleResponse(initialResult);
}

runConversation().catch(error => {
    console.error("\n--- A critical error occurred ---");
    console.error(error.message);
});
