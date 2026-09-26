import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.API_BASE_URL || '/api',
  timeout: 120000, // manual scrapes run a real browser; allow time
});

api.interceptors.response.use(
  (r) => {
    // Misconfiguration guard: if VITE_API_BASE_URL is unset/wrong on Vercel,
    // /api/* hits the static frontend itself, which serves index.html (a
    // string). Without this check, unwrapping `.data` yields `undefined` and
    // the UI crashes on `.length`. Fail here with the actual cause instead.
    if (typeof r.data === 'string') {
      throw new Error('Backend did not return JSON (got HTML). Set VITE_API_BASE_URL to the Render API URL (…/api) and redeploy the frontend.');
    }
    return r.data; // unwrap { success, data }
  },
  (err) => {
    const e = new Error(err?.response?.data?.error?.message || err.message || 'Request failed');
    e.code = err?.response?.data?.error?.code;
    throw e;
  }
);

export const searchProducts = (q) => api.get('/products/search', { params: { q } }).then((r) => r.data);
export const getProduct = (id) => api.get(`/products/${id}`).then((r) => r.data);
export const trackProduct = (productId, optionId) => api.post('/tracked-products', { productId, optionId }).then((r) => r.data);
export const listTracked = () => api.get('/tracked-products').then((r) => r.data);
export const getTracked = (id) => api.get(`/tracked-products/${id}`).then((r) => r.data);
export const getHistory = (id, limit) => api.get(`/tracked-products/${id}/history`, { params: { limit } }).then((r) => r.data);
export const getLogs = (id, limit) => api.get(`/tracked-products/${id}/logs`, { params: { limit } }).then((r) => r.data);
export const scrapeNow = (id) => api.post(`/tracked-products/${id}/scrape`, {}).then((r) => r.data);
export const exportCsvUrl = () => `${import.meta.env.VITE_API_BASE_URL || '/api'}/export/scrape-history.csv`;

export default api;
