import axios from 'axios';
import { config, logger } from '../config/index.js';

const PAYSTACK_API_BASE = 'https://api.paystack.co';

export class PaystackService {
  constructor(secretKey = null, timeoutMs = 10000) {
    this.secretKey = secretKey;
    this.client = axios.create({
      baseURL: PAYSTACK_API_BASE,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Verifies a transaction reference with Paystack API.
   *
   * @param {string} reference
   * @param {string} [correlationId]
   * @returns {Promise<{success: boolean, data?: any, message?: string, statusCode?: number}>}
   */
  async verifyTransaction(reference, correlationId = 'unknown') {
    const cleanRef = String(reference).trim();
    if (!cleanRef) {
      return { success: false, message: 'Transaction reference is required' };
    }

    const secretKey = this.secretKey || config.paystack.secretKey;
    if (!secretKey) {
      logger.error({ correlationId }, 'PAYSTACK_SECRET_KEY is not configured');
      return { success: false, message: 'Paystack secret key is missing' };
    }

    try {
      logger.info({ correlationId, reference: cleanRef }, 'Querying Paystack transaction verification API');

      const response = await this.client.get(`/transaction/verify/${encodeURIComponent(cleanRef)}`, {
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
      });

      if (response.data && response.data.status === true && response.data.data) {
        return {
          success: true,
          data: response.data.data,
          message: response.data.message,
        };
      }

      logger.warn(
        { correlationId, reference, response: response.data },
        'Paystack verification returned false status'
      );
      return {
        success: false,
        message: response.data?.message || 'Transaction verification unsuccessful',
        data: response.data?.data,
      };
    } catch (err) {
      const statusCode = err.response?.status;
      const responseData = err.response?.data;

      logger.error(
        {
          correlationId,
          reference,
          statusCode,
          responseData,
          errMsg: err.message,
        },
        'Failed to verify transaction with Paystack API'
      );

      return {
        success: false,
        statusCode: statusCode || 500,
        message: responseData?.message || err.message || 'Error connecting to Paystack API',
        data: null,
      };
    }
  }

  /**
   * Initializes a transaction with Paystack API.
   *
   * @param {object} payload
   * @param {string} payload.email
   * @param {number} payload.amount
   * @param {string} [payload.reference]
   * @param {object} [payload.metadata]
   * @param {string} [correlationId]
   * @returns {Promise<{success: boolean, data?: any, message?: string, statusCode?: number}>}
   */
  async initializeTransaction(payload, correlationId = 'unknown') {
    if (!payload || !payload.email) {
      return { success: false, message: 'Customer email is required to initialize transaction' };
    }

    const secretKey = this.secretKey || config.paystack.secretKey;
    if (!secretKey) {
      logger.error({ correlationId }, 'PAYSTACK_SECRET_KEY is not configured');
      return { success: false, message: 'Paystack secret key is missing' };
    }

    try {
      logger.info({ correlationId, email: payload.email, reference: payload.reference }, 'Querying Paystack transaction initialization API');

      const response = await this.client.post('/transaction/initialize', payload, {
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
      });

      if (response.data && response.data.status === true && response.data.data) {
        return {
          success: true,
          data: response.data.data,
          message: response.data.message,
        };
      }

      logger.warn(
        { correlationId, payload, response: response.data },
        'Paystack initialization returned false status'
      );
      return {
        success: false,
        message: response.data?.message || 'Transaction initialization unsuccessful',
        data: response.data?.data,
      };
    } catch (err) {
      const statusCode = err.response?.status;
      const responseData = err.response?.data;

      logger.error(
        {
          correlationId,
          statusCode,
          responseData,
          errMsg: err.message,
        },
        'Failed to initialize transaction with Paystack API'
      );

      return {
        success: false,
        statusCode: statusCode || 500,
        message: responseData?.message || err.message || 'Error connecting to Paystack API',
        data: null,
      };
    }
  }
}

export const paystackService = new PaystackService();
export default paystackService;
