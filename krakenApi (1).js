// krakenApi.js
/**
 * @file Kraken Futures API Client
 * @description A comprehensive client for interacting with the Kraken Futures REST API,
 *              handling both public and private authenticated endpoints.
 * @author Your Name
 * @version 1.1.0
 */

import crypto from 'crypto';
import axios from 'axios';
import qs from 'querystring';

/**
 * A class to interact with the Kraken Futures API.
 */
export class KrakenFuturesApi {
    /**
     * Constructs the API client.
     * @param {string} apiKey - Your Kraken Futures API key.
     * @param {string} apiSecret - Your Kraken Futures API secret.
     * @param {string} [baseUrl='https://futures.kraken.com'] - The base URL for the API.
     */
    constructor(apiKey, apiSecret, baseUrl = 'https://futures.kraken.com') {
        if (!apiKey || !apiSecret) {
            throw new Error("API key and secret are required.");
        }
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.baseUrl = baseUrl;
        this.nonceCounter = 0;
    }

    /**
     * Creates a unique, ever-increasing nonce for each request.
     * Appends a counter to the timestamp to ensure uniqueness for rapid requests.
     * @private
     * @returns {string} A timestamp-based nonce.
     */
    _createNonce() {
        if (this.nonceCounter > 9999) {
            this.nonceCounter = 0;
        }
        // Pad counter to 5 digits to ensure nonce is always increasing
        const counterStr = this.nonceCounter.toString().padStart(5, '0');
        this.nonceCounter++;
        return Date.now() + counterStr;
    }

    /**
     * Signs the request data to create the 'Authent' header required for private endpoints.
     * @private
     * @param {string} endpoint - The API endpoint path (e.g., '/derivatives/api/v3/sendorder').
     * @param {string} nonce - The unique nonce for this request.
     * @param {string} postData - The URL-encoded string of parameters for POST requests.
     * @returns {string} The Base64-encoded signature.
     */
    _signRequest(endpoint, nonce, postData) {
        const path = endpoint.replace('/derivatives', ''); // Remove prefix for signing
        const message = postData + nonce + path;
        const hash = crypto.createHash('sha256').update(message).digest();
        const secretDecoded = Buffer.from(this.apiSecret, 'base64');
        const hmac = crypto.createHmac('sha512', secretDecoded);
        return hmac.update(hash).digest('base64');
    }

    /**
     * Makes a generic, authenticated request to the Kraken Futures API.
     * @private
     * @param {'GET' | 'POST'} method - The HTTP method.
     * @param {string} endpoint - The API endpoint path.
     * @param {object} [params={}] - The request parameters.
     * @returns {Promise<object>} The API response data.
     * @throws {Error} Throws a detailed error if the request fails.
     */
    async _request(method, endpoint, params = {}) {
        const url = this.baseUrl + endpoint;
        const nonce = this._createNonce();
        const postData = (method === 'POST') ? qs.stringify(params) : '';

        const headers = {
            'APIKey': this.apiKey,
            'Nonce': nonce,
            'Authent': this._signRequest(endpoint, nonce, postData),
            'User-Agent': 'TradingBot/1.0'
        };

        const requestConfig = { method, url, headers };

        if (method === 'POST') {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            requestConfig.data = postData;
        } else if (Object.keys(params).length > 0) {
            requestConfig.url += '?' + qs.stringify(params);
        }

        try {
            const response = await axios(requestConfig);
            return response.data;
        } catch (error) {
            const errorInfo = error.response?.data || { message: error.message };
            console.error(`API Error on ${method} ${endpoint}:`, JSON.stringify(errorInfo, null, 2));
            throw new Error(`[${method} ${endpoint}] Failed: ${JSON.stringify(errorInfo)}`);
        }
    }

    // --- Public Market Data Endpoints ---
    getInstruments = () => this._request('GET', '/derivatives/api/v3/instruments');
    getTickers = () => this._request('GET', '/derivatives/api/v3/tickers');
    getOrderbook = (params) => this._request('GET', '/derivatives/api/v3/orderbook', params);
    getHistory = (params) => this._request('GET', '/derivatives/api/v3/history', params);

    // --- Private Account Data Endpoints ---
    getAccounts = () => this._request('GET', '/derivatives/api/v3/accounts');
    getOpenOrders = () => this._request('GET', '/derivatives/api/v3/openorders');
    getOpenPositions = () => this._request('GET', '/derivatives/api/v3/openpositions');
    getRecentOrders = (params) => this._request('GET', '/derivatives/api/v3/recentorders', params);
    getFills = (params) => this._request('GET', '/derivatives/api/v3/fills', params);
    getTransfers = (params) => this._request('GET', '/derivatives/api/v3/transfers', params);
    getNotifications = () => this._request('GET', '/derivatives/api/v3/notifications');

    // --- Private Order Management Endpoints ---
    sendOrder = (params) => this._request('POST', '/derivatives/api/v3/sendorder', params);
    editOrder = (params) => this._request('POST', '/derivatives/api/v3/editorder', params);
    cancelOrder = (params) => this._request('POST', '/derivatives/api/v3/cancelorder', params);
    cancelAllOrders = (params) => this._request('POST', '/derivatives/api/v3/cancelallorders', params);
    cancelAllOrdersAfter = (params) => this._request('POST', '/derivatives/api/v3/cancelallordersafter', params);
    batchOrder = (params) => this._request('POST', '/derivatives/api/v3/batchorder', params);

    /**
     * Fetches public OHLC data from Kraken's spot API (not Futures).
     * This is a standalone method that does not use the authenticated request logic.
     * @param {object} params - The parameters for the OHLC request.
     * @param {string} [params.pair='XBTUSD'] - The asset pair (e.g., 'XBTUSD').
     * @param {number} [params.interval=60] - The time frame interval in minutes.
     * @param {number} [params.since=null] - Return data since given timestamp.
     * @returns {Promise<Array<object>|null>} A promise that resolves to formatted OHLC data or null on error.
     */
    async fetchKrakenData({ pair = 'XBTUSD', interval = 60, since = null }) {
        const url = `https://api.kraken.com/0/public/OHLC`;
        const queryParams = { pair, interval };
        if (since) {
            queryParams.since = since;
        }

        try {
            const response = await axios.get(url, { params: queryParams });
            const data = response.data;

            if (data.error?.length > 0) {
                throw new Error(data.error.join(', '));
            }

            const resultKey = Object.keys(data.result)[0];
            if (!resultKey || resultKey === 'last') return []; // Handle empty or partial responses

            return data.result[resultKey].map(item => ({
                date: new Date(item[0] * 1000).toISOString(),
                open: parseFloat(item[1]),
                high: parseFloat(item[2]),
                low: parseFloat(item[3]),
                close: parseFloat(item[4]),
                volume: parseFloat(item[6]),
            }));
        } catch (error) {
            console.error(`Error fetching Kraken OHLC data for ${pair}:`, error.message);
            return null;
        }
    }
}

// This makes the class available as a named export.
export default KrakenFuturesApi;
                
