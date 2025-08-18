import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai'; // Reverted
import KrakenFuturesApi from './krakenApi.js'; // Assuming krakenApi.js is in the same directory
import 'dotenv/config';

// --- Configuration ---
const KRAKEN_API_KEY = process.env.KRAKEN_API_KEY;
const KRAKEN_API_SECRET = process.env.KRAKEN_API_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET || !GEMINI_API_KEY) {
    console.error("Error: Missing required environment variables (KRAKEN_API_KEY, KRAKEN_API_SECRET, GEMINI_API_KEY).");
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
        description: 'Fetches historical OHLC (Open, High, Low, Close) price data for a given trading pair.',
        parameters: {
            type: SchemaType.OBJECT, // Reverted
            properties: {
                pair: { type: SchemaType.STRING, description: "The trading pair, e.g., 'PI_XBTUSD'." }, // Reverted
                interval: { type: SchemaType.NUMBER, description: 'The time frame interval in minutes (e.g., 60 for 1 hour).' } // Reverted
            },
            required: ['pair', 'interval']
        }
    },
    {
        name: 'getAvailableMargin',
        description: 'Retrieves the total available margin and balance information from the trading account.',
        parameters: { type: SchemaType.OBJECT, properties: {}, required: [] } // Reverted
    },
    {
        name: 'getOpenPositions',
        description: 'Fetches all currently open positions in the trading account.',
        parameters: { type: SchemaType.OBJECT, properties: {}, required: [] } // Reverted
    },
    {
        name: 'getOpenOrders',
        description: 'Retrieves a list of all currently open (unfilled) orders.',
        parameters: { type: SchemaType.OBJECT, properties: {}, required: [] } // Reverted
    },
    {
        name: 'cancelOrder',
        description: 'Cancels a specific open order using its order ID.',
        parameters: {
            type: SchemaType.OBJECT, // Reverted
            properties: {
                order_id: { type: SchemaType.STRING, description: 'The unique identifier of the order to cancel.' } // Reverted
            },
            required: ['order_id']
        }
    },
    {
        name: 'hold',
        description: 'Pauses execution for a specified number of seconds to wait for market conditions to change.',
        parameters: {
            type: SchemaType.OBJECT, // Reverted
            properties: {
                duration: { type: SchemaType.NUMBER, description: 'The duration to wait, in seconds.' } // Reverted
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

// --- Main Execution Logic ---
(async () => {
    console.log("Starting Gemini Trading Bot...");

    const prompt = `
        You are an autonomous trading AI. Your goal is to grow the account balance by executing a trading strategy.
        1.  Analyze the current market by fetching historical price data for 'PI_XBTUSD' on a 60-minute interval.
        2.  Check the available margin and any open positions or orders.
        3.  Based on your analysis, decide on a trading action. You can place new orders, cancel existing ones, or hold.
        4.  For now, your primary task is to analyze and report. Do not place an order yet.
        5.  Explain your reasoning and the data you've gathered.
        6.  If there are any open orders you deem unnecessary, cancel one of them.
        7.  Conclude by holding for 10 seconds.
    `;

    const chat = model.startChat({ tools: [{ functionDeclarations: tools }] });
    let result = await chat.sendMessage(prompt);

    while (true) {
        const calls = result.response.functionCalls();
        if (!calls || calls.length === 0) {
            console.log("Gemini's final response:");
            console.log(result.response.text());
            break;
        }

        console.log(`\n--- Gemini wants to call ${calls.length} function(s) ---`);
        const toolResponses = [];

        for (const call of calls) {
            const toolName = call.name;
            if (registry[toolName]) {
                console.log(`Executing: ${toolName}(${JSON.stringify(call.args)})`);
                try {
                    const apiResult = await registry[toolName](call.args);
                    toolResponses.push({
                        functionName: toolName,
                        response: { result: apiResult }
                    });
                } catch (error) {
                    console.error(`Error executing ${toolName}:`, error);
                    toolResponses.push({
                        functionName: toolName,
                        response: { error: error.message }
                    });
                }
            } else {
                console.warn(`Warning: Unknown tool '${toolName}' requested by Gemini.`);
            }
        }

        // Send results back to Gemini
        result = await chat.sendMessage(JSON.stringify(toolResponses));
    }
})();
