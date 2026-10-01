'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Activity,
  Server,
  Zap,
  Globe,
  Settings,
  Send,
  Search,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Cpu,
  Layers,
  ShieldCheck,
  ShieldAlert,
  Copy,
  Plus,
  Trash2,
  Edit2,
  ExternalLink,
  Eye,
  EyeOff,
  Radio,
  Check,
  Code,
  Sliders,
  Terminal,
  Filter,
  GitFork,
  Lock,
  LogOut,
  User,
  Key,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  X,
  RotateCcw,
} from 'lucide-react';

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  // Authentication State
  const [authToken, setAuthToken] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [loginForm, setLoginForm] = useState({ username: 'admin', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');

  // Stats & Health
  const [stats, setStats] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Auto-detected domain for Paystack configuration
  const [currentOrigin, setCurrentOrigin] = useState('');
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setCurrentOrigin(window.location.origin);
    }
  }, []);

  const paystackWebhookUrl = currentOrigin ? `${currentOrigin}/api/v1/paystack/webhook` : '/api/v1/paystack/webhook';
  const paystackCallbackUrl = currentOrigin ? `${currentOrigin}/api/v1/paystack/callback` : '/api/v1/paystack/callback';

  // Events Log
  const [events, setEvents] = useState([]);
  const [eventsFilter, setEventsFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [siteFilter, setSiteFilter] = useState('ALL');
  const [eventsPage, setEventsPage] = useState(1);
  const [eventsPageSize, setEventsPageSize] = useState(25);
  const [totalEvents, setTotalEvents] = useState(0);
  const [totalEventPages, setTotalEventPages] = useState(1);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [purgingLogs, setPurgingLogs] = useState(false);

  // Sites
  const [sites, setSites] = useState([]);
  const [siteModalOpen, setSiteModalOpen] = useState(false);
  const [editingSite, setEditingSite] = useState(null);
  const [siteForm, setSiteForm] = useState({
    key: '',
    name: '',
    webhookUrl: '',
    callbackUrl: '',
    secret: '',
    referencePrefixes: '',
    referencePatterns: '',
    walletCallbackUrl: '',
    checkoutCallbackUrl: '',
    otherFlows: '',
  });
  const [pingResults, setPingResults] = useState({});
  const [pingingKey, setPingingKey] = useState(null);

  // Config / Settings
  const [configData, setConfigData] = useState({
    paystack: {
      secretKey: '',
      webhookSecret: '',
      enableIpWhitelist: false,
      ipWhitelist: [],
    },
    proxy: {
      sharedSecret: '',
      timeoutMs: 8000,
      maxRetries: 4,
      retryDelays: [15000, 60000, 300000, 900000],
      queueStore: 'memory',
      sqliteDbPath: './data/proxy.db',
      redisUrl: 'redis://127.0.0.1:6379/0',
      idempotencyTtlSeconds: 86400,
      logRetentionDays: 30,
    },
    notifications: {
      discordWebhookUrl: '',
      telegram: {
        botToken: '',
        chatId: '',
      },
    },
    server: {
      port: 3000,
      env: 'development',
      logLevel: 'info',
      sitesConfigPath: './config/sites.json',
    },
    dashboard: {
      authEnabled: true,
      username: 'admin',
      hasPassword: true,
      sessionHours: 24,
      newPassword: '',
    },
  });
  const [showPaystackSecret, setShowPaystackSecret] = useState(false);
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);
  const [showProxySecret, setShowProxySecret] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  // Sync active tab with URL hash for bookmarking and page reloads
  useEffect(() => {
    const validTabs = ['overview', 'events', 'sites', 'settings', 'simulator', 'verifier'];
    const handleHash = () => {
      const hash = window.location.hash.replace('#', '').trim();
      if (validTabs.includes(hash)) {
        setActiveTab(hash);
      }
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, []);

  const changeTab = (tabId) => {
    setActiveTab(tabId);
    if (typeof window !== 'undefined') {
      window.location.hash = tabId;
    }
    if (tabId === 'settings' || tabId === 'overview') {
      fetchConfig();
    }
  };

  // Webhook Simulator
  const [simForm, setSimForm] = useState({
    eventType: 'charge.success',
    siteKey: '',
    reference: '',
    amount: 5000,
    email: 'alex.customer@example.com',
    currency: 'GHS',
    routingMechanism: 'both',
    customPayloadMode: false,
    customPayload: '',
  });
  const [simResult, setSimResult] = useState(null);
  const [simulating, setSimulating] = useState(false);

  // Transaction Verifier
  const [verifyRef, setVerifyRef] = useState('');
  const [verifyResult, setVerifyResult] = useState(null);
  const [verifying, setVerifying] = useState(false);

  const showToastMsg = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // Authenticated fetch wrapper attaching Bearer token and intercepting 401
  const authFetch = useCallback(async (url, options = {}) => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('paystack_proxy_token') : null;
    const headers = {
      ...options.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401 && !url.includes('/auth/login')) {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('paystack_proxy_token');
      }
      setAuthToken(null);
      setCurrentUser(null);
      setLoginError('Your session has expired. Please sign in again.');
    }
    return res;
  }, []);

  const eventsFilterRef = useRef(eventsFilter);
  eventsFilterRef.current = eventsFilter;
  const statusFilterRef = useRef(statusFilter);
  statusFilterRef.current = statusFilter;
  const siteFilterRef = useRef(siteFilter);
  siteFilterRef.current = siteFilter;
  const eventsPageRef = useRef(eventsPage);
  eventsPageRef.current = eventsPage;
  const eventsPageSizeRef = useRef(eventsPageSize);
  eventsPageSizeRef.current = eventsPageSize;

  // Fetch events with server-side pagination & filter support
  const fetchEventsData = useCallback(async (opts = {}) => {
    const pageToFetch = opts.page ?? eventsPageRef.current;
    const limitToFetch = opts.limit ?? eventsPageSizeRef.current;
    const statusToFetch = opts.status ?? statusFilterRef.current;
    const siteToFetch = opts.site ?? siteFilterRef.current;
    const searchToFetch = opts.search !== undefined ? opts.search : eventsFilterRef.current;

    try {
      setEventsLoading(true);
      const params = new URLSearchParams({
        page: String(pageToFetch),
        limit: String(limitToFetch),
      });
      if (statusToFetch && statusToFetch !== 'ALL') {
        params.set('status', statusToFetch);
      }
      if (siteToFetch && siteToFetch !== 'ALL') {
        params.set('site', siteToFetch);
      }
      if (searchToFetch && searchToFetch.trim()) {
        params.set('search', searchToFetch.trim());
      }

      const res = await authFetch(`/api/v1/dashboard/events?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        setEvents(json.events || []);
        if (json.total != null) setTotalEvents(json.total);
        if (json.totalPages != null) setTotalEventPages(json.totalPages);
        if (json.page != null) setEventsPage(json.page);
      }
    } catch (err) {
      console.error('Failed to fetch events telemetry:', err);
    } finally {
      setEventsLoading(false);
    }
  }, [authFetch]);

  // Fetch stats & events
  const fetchStatsAndEvents = useCallback(async () => {
    try {
      const statsRes = await authFetch('/api/v1/dashboard/stats');
      if (statsRes.ok) {
        const statsJson = await statsRes.json();
        setStats(statsJson);
      }
      await fetchEventsData();
      setError(null);
    } catch (err) {
      console.error('Failed to fetch dashboard data:', err);
    } finally {
      setLoading(false);
    }
  }, [authFetch, fetchEventsData]);

  // Fetch sites
  const fetchSites = useCallback(async () => {
    try {
      const res = await authFetch('/api/v1/dashboard/sites');
      if (res.ok) {
        const json = await res.json();
        setSites(json.sites || []);
        if (json.sites?.length > 0 && !simForm.siteKey) {
          setSimForm(prev => ({ ...prev, siteKey: json.sites[0].key }));
        }
      }
    } catch (err) {
      console.error('Failed to fetch sites:', err);
    }
  }, [authFetch, simForm.siteKey]);

  // Fetch Config
  const fetchConfig = useCallback(async () => {
    try {
      const res = await authFetch('/api/v1/dashboard/config');
      if (res.ok) {
        const json = await res.json();
        if (json.config) {
          setConfigData(prev => ({
            ...prev,
            ...json.config,
            dashboard: {
              ...prev.dashboard,
              ...(json.config.dashboard || {}),
              newPassword: '',
            },
          }));
        }
      }
    } catch (err) {
      console.error('Failed to fetch config:', err);
    }
  }, [authFetch]);

  // Verify stored session token on mount
  useEffect(() => {
    const checkAuth = async () => {
      const storedToken = typeof window !== 'undefined' ? localStorage.getItem('paystack_proxy_token') : null;
      if (!storedToken) {
        setAuthChecked(true);
        setLoading(false);
        return;
      }

      try {
        const res = await fetch('/api/v1/dashboard/auth/me', {
          headers: { Authorization: `Bearer ${storedToken}` },
        });
        if (res.ok) {
          const data = await res.json();
          setAuthToken(storedToken);
          setCurrentUser(data.user || { username: 'admin' });
        } else {
          localStorage.removeItem('paystack_proxy_token');
          setAuthToken(null);
        }
      } catch (err) {
        console.error('Auth verification failed:', err);
        setAuthToken(null);
      } finally {
        setAuthChecked(true);
        setLoading(false);
      }
    };

    checkAuth();
  }, []);

  // Load data once authenticated
  useEffect(() => {
    if (!authToken) return;
    fetchStatsAndEvents();
    fetchSites();
    fetchConfig();
  }, [authToken, fetchStatsAndEvents, fetchSites, fetchConfig]);

  // Polling effect while authenticated
  useEffect(() => {
    if (!autoRefresh || !authToken) return;
    const interval = setInterval(() => {
      fetchStatsAndEvents();
    }, 4000);
    return () => clearInterval(interval);
  }, [autoRefresh, authToken, fetchStatsAndEvents]);

  // Server-Sent Events (SSE) stream for instant real-time sync with fallback to polling
  useEffect(() => {
    if (!authToken || !autoRefresh || typeof window === 'undefined' || !window.EventSource) return;

    let eventSource = null;
    try {
      const streamUrl = `/api/v1/dashboard/events/stream?token=${encodeURIComponent(authToken)}`;
      eventSource = new EventSource(streamUrl);

      eventSource.addEventListener('stats', (e) => {
        try {
          const statsData = JSON.parse(e.data);
          if (statsData?.metrics) {
            setStats(statsData);
          }
        } catch {}
      });

      eventSource.addEventListener('event', (e) => {
        try {
          const evt = JSON.parse(e.data);
          if (evt?.id) {
            setEvents(prev => {
              const idx = prev.findIndex(item => item.id === evt.id);
              if (idx >= 0) {
                const nextList = [...prev];
                nextList[idx] = evt;
                return nextList;
              }
              // Check if matches active filters before prepending
              const upper = (statusFilterRef.current || 'ALL').toUpperCase();
              if (upper !== 'ALL') {
                const evStatus = (evt.status || '').toUpperCase();
                if (upper === 'SUCCESS' || upper === 'FORWARDED') {
                  if (evStatus !== 'SUCCESS' && evStatus !== 'FORWARDED') return prev;
                } else if (evStatus !== upper) {
                  return prev;
                }
              }
              if (siteFilterRef.current && siteFilterRef.current !== 'ALL' && evt.siteKey !== siteFilterRef.current) {
                return prev;
              }
              if (eventsFilterRef.current && eventsFilterRef.current.trim()) {
                const term = eventsFilterRef.current.trim().toLowerCase();
                const match = (evt.eventType || '').toLowerCase().includes(term) ||
                  (evt.eventKey || '').toLowerCase().includes(term) ||
                  (evt.reference || '').toLowerCase().includes(term) ||
                  (evt.siteKey || '').toLowerCase().includes(term) ||
                  (evt.error || '').toLowerCase().includes(term) ||
                  (evt.correlationId || '').toLowerCase().includes(term) ||
                  (evt.id || '').toLowerCase().includes(term);
                if (!match) return prev;
              }
              setTotalEvents(t => t + 1);
              if (eventsPageRef.current === 1) {
                return [evt, ...prev].slice(0, eventsPageSizeRef.current);
              }
              return prev;
            });
          }
        } catch {}
      });

      eventSource.onerror = () => {
        if (eventSource) {
          eventSource.close();
        }
      };
    } catch (err) {
      console.warn('SSE connection failed, falling back to interval polling:', err);
    }

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [authToken, autoRefresh]);

  // Ping a child site
  const handlePingSite = async (key) => {
    setPingingKey(key);
    try {
      const res = await authFetch(`/api/v1/dashboard/sites/${encodeURIComponent(key)}/ping`, {
        method: 'POST',
      });
      const data = await res.json();
      setPingResults(prev => ({ ...prev, [key]: data }));
      if (data.reachable) {
        showToastMsg(`Site "${key}" is reachable (${data.durationMs}ms, HTTP ${data.httpStatus})`, 'success');
      } else {
        showToastMsg(`Site "${key}" unreachable: ${data.error || 'Connection failed'}`, 'error');
      }
    } catch (err) {
      setPingResults(prev => ({ ...prev, [key]: { reachable: false, error: err.message } }));
      showToastMsg(`Failed to ping site "${key}": ${err.message}`, 'error');
    } finally {
      setPingingKey(null);
    }
  };

  // Open site modal for Add
  const handleOpenAddSite = () => {
    setEditingSite(null);
    setSiteForm({
      key: '',
      name: '',
      webhookUrl: '',
      callbackUrl: '',
      secret: '',
      referencePrefixes: '',
      referencePatterns: '',
      walletCallbackUrl: '',
      checkoutCallbackUrl: '',
      otherFlows: '',
    });
    setSiteModalOpen(true);
  };

  // Open site modal for Edit
  const handleOpenEditSite = (site) => {
    setEditingSite(site.key);
    const prefixes = Array.isArray(site.referencePrefixes)
      ? site.referencePrefixes.join(', ')
      : (site.referencePrefixes || '');
    const patterns = Array.isArray(site.referencePatterns)
      ? site.referencePatterns.join(', ')
      : (site.referencePatterns || '');
    const flows = site.flowRoutes || site.callbackRules || {};
    const otherFlowEntries = Object.entries(flows).filter(([k]) => k !== 'wallet' && k !== 'checkout');
    const otherFlowsStr = otherFlowEntries.length > 0 ? JSON.stringify(Object.fromEntries(otherFlowEntries), null, 2) : '';

    setSiteForm({
      key: site.key,
      name: site.name || '',
      webhookUrl: site.webhookUrl || '',
      callbackUrl: site.callbackUrl || '',
      secret: site.secret || '',
      referencePrefixes: prefixes,
      referencePatterns: patterns,
      walletCallbackUrl: flows.wallet || '',
      checkoutCallbackUrl: flows.checkout || '',
      otherFlows: otherFlowsStr,
    });
    setSiteModalOpen(true);
  };

  // Save Site (Create or Update)
  const handleSaveSite = async (e) => {
    e.preventDefault();
    if (!siteForm.key.trim() || !siteForm.webhookUrl.trim()) {
      showToastMsg('Site key and Webhook URL are required', 'error');
      return;
    }

    const prefixes = siteForm.referencePrefixes
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);

    const patterns = siteForm.referencePatterns
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);

    const flowRoutes = {};
    if (editingSite) {
      const existing = sites.find(s => s.key === editingSite);
      const existingFlows = existing?.flowRoutes || existing?.callbackRules || {};
      for (const [k, v] of Object.entries(existingFlows)) {
        if (k !== 'wallet' && k !== 'checkout') {
          flowRoutes[k] = v;
        }
      }
    }

    if (siteForm.otherFlows?.trim()) {
      try {
        const parsed = JSON.parse(siteForm.otherFlows);
        if (typeof parsed === 'object' && parsed !== null) {
          Object.assign(flowRoutes, parsed);
        }
      } catch (err) {
        showToastMsg('Additional flow routes must be a valid JSON object (or empty)', 'error');
        return;
      }
    }

    if (siteForm.walletCallbackUrl?.trim()) {
      flowRoutes.wallet = siteForm.walletCallbackUrl.trim();
    } else {
      delete flowRoutes.wallet;
    }
    if (siteForm.checkoutCallbackUrl?.trim()) {
      flowRoutes.checkout = siteForm.checkoutCallbackUrl.trim();
    } else {
      delete flowRoutes.checkout;
    }

    const payload = {
      name: siteForm.name,
      webhookUrl: siteForm.webhookUrl,
      callbackUrl: siteForm.callbackUrl,
      secret: siteForm.secret,
      referencePrefixes: prefixes,
      referencePatterns: patterns,
      flowRoutes,
    };

    try {
      if (editingSite) {
        // Update
        const res = await authFetch(`/api/v1/dashboard/sites/${encodeURIComponent(editingSite)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            newKey: siteForm.key !== editingSite ? siteForm.key : undefined,
          }),
        });
        const data = await res.json();
        if (data.status) {
          showToastMsg(`Site "${siteForm.key}" updated successfully!`);
          setSiteModalOpen(false);
          fetchSites();
        } else {
          showToastMsg(data.message || 'Failed to update site', 'error');
        }
      } else {
        // Create
        const res = await authFetch('/api/v1/dashboard/sites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key: siteForm.key,
            ...payload,
          }),
        });
        const data = await res.json();
        if (data.status) {
          showToastMsg(`Child site "${siteForm.key}" added successfully!`);
          setSiteModalOpen(false);
          fetchSites();
        } else {
          showToastMsg(data.message || 'Failed to create site', 'error');
        }
      }
    } catch (err) {
      showToastMsg(`Error saving site: ${err.message}`, 'error');
    }
  };

  // Delete Site
  const handleDeleteSite = async (key) => {
    if (!confirm(`Are you sure you want to delete child site "${key}"? This action removes it from config/sites.json immediately.`)) {
      return;
    }
    try {
      const res = await authFetch(`/api/v1/dashboard/sites/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.status) {
        showToastMsg(`Site "${key}" deleted successfully.`);
        fetchSites();
      } else {
        showToastMsg(data.message || 'Failed to delete site', 'error');
      }
    } catch (err) {
      showToastMsg(`Failed to delete site: ${err.message}`, 'error');
    }
  };

  // Save Configuration to .env and runtime
  const handleSaveConfig = async (e) => {
    e.preventDefault();
    setSavingConfig(true);
    try {
      const payload = {
        paystack: {
          secretKey: configData.paystack.secretKey,
          webhookSecret: configData.paystack.webhookSecret,
          enableIpWhitelist: configData.paystack.enableIpWhitelist,
          ipWhitelist: Array.isArray(configData.paystack.ipWhitelist)
            ? configData.paystack.ipWhitelist
            : String(configData.paystack.ipWhitelist || '').split(',').map(s => s.trim()).filter(Boolean),
        },
        proxy: {
          sharedSecret: configData.proxy.sharedSecret,
          timeoutMs: Number(configData.proxy.timeoutMs) || 8000,
          maxRetries: Number.isNaN(Number(configData.proxy.maxRetries)) ? 4 : Number(configData.proxy.maxRetries),
          retryDelays: Array.isArray(configData.proxy.retryDelays)
            ? configData.proxy.retryDelays
            : String(configData.proxy.retryDelays || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n)),
          queueStore: configData.proxy.queueStore,
          sqliteDbPath: configData.proxy.sqliteDbPath,
          redisUrl: configData.proxy.redisUrl,
          idempotencyTtlSeconds: Number(configData.proxy.idempotencyTtlSeconds) || 86400,
          logRetentionDays: Number(configData.proxy.logRetentionDays) || 30,
        },
        notifications: {
          discordWebhookUrl: configData.notifications.discordWebhookUrl,
          telegram: {
            botToken: configData.notifications.telegram.botToken,
            chatId: configData.notifications.telegram.chatId,
          },
        },
        server: {
          port: Number(configData.server.port) || 3000,
          env: configData.server.env || 'development',
          logLevel: configData.server.logLevel || 'info',
          sitesConfigPath: configData.server.sitesConfigPath || './config/sites.json',
        },
        dashboard: {
          authEnabled: Boolean(configData.dashboard?.authEnabled),
          username: configData.dashboard?.username || 'admin',
          ...(configData.dashboard?.newPassword ? { password: configData.dashboard.newPassword } : {}),
          sessionHours: Number(configData.dashboard?.sessionHours) || 24,
        },
      };

      const res = await authFetch('/api/v1/dashboard/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result = await res.json();
      if (result.status) {
        showToastMsg('Configuration saved successfully and applied immediately without restart!');
        if (result.config) {
          setConfigData(prev => ({
            ...prev,
            ...result.config,
            dashboard: {
              ...prev.dashboard,
              ...(result.config.dashboard || {}),
              newPassword: '',
            },
          }));
        }
        fetchStatsAndEvents();
      } else {
        showToastMsg(result.message || 'Failed to update configuration', 'error');
      }
    } catch (err) {
      showToastMsg(`Failed to save configuration: ${err.message}`, 'error');
    } finally {
      setSavingConfig(false);
    }
  };

  // Run Webhook Simulator
  const handleSimulateWebhook = async (e) => {
    e.preventDefault();
    setSimulating(true);
    setSimResult(null);

    try {
      let body;
      if (simForm.customPayloadMode) {
        body = { customPayload: simForm.customPayload };
      } else {
        body = {
          eventType: simForm.eventType,
          siteKey: simForm.siteKey,
          reference: simForm.reference,
          amount: Number(simForm.amount),
          email: simForm.email,
          currency: simForm.currency,
          routingMechanism: simForm.routingMechanism,
        };
      }

      const res = await authFetch('/api/v1/dashboard/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      setSimResult(data);

      if (data.status) {
        if (data.duplicate) {
          showToastMsg('Simulated event detected as duplicate', 'info');
        } else if (data.unroutable) {
          showToastMsg('Simulated event ingested but unroutable', 'warning');
        } else {
          showToastMsg(`Webhook simulated & routed to "${data.resolvedSite}"!`, 'success');
        }
        fetchStatsAndEvents();
      } else {
        showToastMsg(data.message || 'Simulator encountered an error', 'error');
      }
    } catch (err) {
      showToastMsg(`Simulator error: ${err.message}`, 'error');
    } finally {
      setSimulating(false);
    }
  };

  // Run Transaction Verifier
  const handleVerifyTransaction = async (e) => {
    e.preventDefault();
    if (!verifyRef.trim()) {
      showToastMsg('Please enter a Paystack reference', 'error');
      return;
    }
    setVerifying(true);
    setVerifyResult(null);

    try {
      const res = await authFetch(`/api/v1/dashboard/verify/${encodeURIComponent(verifyRef.trim())}`);
      const data = await res.json();
      setVerifyResult(data);
      if (data.status) {
        showToastMsg(`Transaction reference verified!`);
      } else {
        showToastMsg(data.message || 'Verification unsuccessful', 'error');
      }
    } catch (err) {
      showToastMsg(`Verification failed: ${err.message}`, 'error');
    } finally {
      setVerifying(false);
    }
  };

  // Admin Login Handler
  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError('');

    try {
      const res = await fetch('/api/v1/dashboard/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginForm),
      });

      const data = await res.json();
      if (res.ok && data.status && data.token) {
        if (typeof window !== 'undefined') {
          localStorage.setItem('paystack_proxy_token', data.token);
        }
        setAuthToken(data.token);
        setCurrentUser(data.user);
        showToastMsg(`Welcome back, ${data.user?.username || 'admin'}!`);
      } else {
        setLoginError(data.message || 'Invalid username or password');
      }
    } catch (err) {
      setLoginError(`Network or server error: ${err.message}`);
    } finally {
      setLoginLoading(false);
    }
  };

  // Admin Logout Handler
  const handleLogout = async () => {
    try {
      await authFetch('/api/v1/dashboard/auth/logout', { method: 'POST' });
    } catch (err) {
      console.error('Logout error:', err);
    }
    if (typeof window !== 'undefined') {
      localStorage.removeItem('paystack_proxy_token');
    }
    setAuthToken(null);
    setCurrentUser(null);
    showToastMsg('Signed out of dashboard');
  };

  // Debounce search filter input
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchEventsData({ search: eventsFilter, page: 1 });
    }, 300);
    return () => clearTimeout(timer);
  }, [eventsFilter, fetchEventsData]);

  const handleStatusFilterChange = (st) => {
    setStatusFilter(st);
    setEventsPage(1);
    fetchEventsData({ status: st, page: 1 });
  };

  const handleSiteFilterChange = (site) => {
    setSiteFilter(site);
    setEventsPage(1);
    fetchEventsData({ site, page: 1 });
  };

  const handlePageChange = (newPage) => {
    const target = Math.max(1, Math.min(totalEventPages, newPage));
    setEventsPage(target);
    fetchEventsData({ page: target });
  };

  const handlePageSizeChange = (newSize) => {
    setEventsPageSize(newSize);
    setEventsPage(1);
    fetchEventsData({ limit: newSize, page: 1 });
  };

  const handleResetFilters = () => {
    setEventsFilter('');
    setStatusFilter('ALL');
    setSiteFilter('ALL');
    setEventsPage(1);
    fetchEventsData({ search: '', status: 'ALL', site: 'ALL', page: 1 });
  };

  const handlePurgeOldLogs = async () => {
    const days = configData?.proxy?.logRetentionDays || 30;
    if (!window.confirm(`Are you sure you want to delete event logs older than ${days} days?`)) {
      return;
    }
    setPurgingLogs(true);
    try {
      const res = await authFetch('/api/v1/dashboard/events/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retentionDays: days }),
      });
      const data = await res.json();
      if (data.status) {
        showToastMsg(`Pruned ${data.deletedLogs || 0} event log(s) older than ${data.retentionDays} days`, 'success');
        await fetchEventsData();
      } else {
        showToastMsg(data.message || 'Log cleanup failed', 'error');
      }
    } catch (err) {
      showToastMsg(`Cleanup failed: ${err.message}`, 'error');
    } finally {
      setPurgingLogs(false);
    }
  };

  // Filtered Events
  const filteredEvents = useMemo(() => {
    const term = eventsFilter.trim().toLowerCase();
    const upperStatus = statusFilter.toUpperCase();

    return events.filter(ev => {
      // Status matching
      if (upperStatus !== 'ALL') {
        const evStatus = (ev.status || '').toUpperCase();
        if (upperStatus === 'SUCCESS' || upperStatus === 'FORWARDED') {
          if (evStatus !== 'SUCCESS' && evStatus !== 'FORWARDED') return false;
        } else if (evStatus !== upperStatus) {
          return false;
        }
      }

      // Site matching
      if (siteFilter !== 'ALL') {
        if (ev.siteKey !== siteFilter) return false;
      }

      // Search matching
      if (term) {
        const matchEvent = (ev.eventType || '').toLowerCase().includes(term);
        const matchKey = (ev.eventKey || '').toLowerCase().includes(term);
        const matchRef = (ev.reference || '').toLowerCase().includes(term);
        const matchSite = (ev.siteKey || '').toLowerCase().includes(term);
        const matchErr = (ev.error || '').toLowerCase().includes(term);
        const matchCorr = (ev.correlationId || '').toLowerCase().includes(term);
        const matchId = (ev.id || '').toLowerCase().includes(term);
        const matchUrl = (ev.targetUrl || '').toLowerCase().includes(term);
        if (!matchEvent && !matchKey && !matchRef && !matchSite && !matchErr && !matchCorr && !matchId && !matchUrl) {
          return false;
        }
      }

      return true;
    });
  }, [events, eventsFilter, statusFilter, siteFilter]);

  const copyToClipboard = async (text, label) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (typeof document !== 'undefined') {
        const textArea = document.createElement('textarea');
        textArea.value = text || '';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      showToastMsg(`${label || 'Content'} copied to clipboard!`);
    } catch {
      showToastMsg(`Failed to copy ${label || 'content'} to clipboard`, 'error');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-cyan-500 selection:text-white">
      {/* Toast Notification */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-lg shadow-xl border text-sm font-medium transition-all transform animate-bounce ${
          toast.type === 'error'
            ? 'bg-red-950/90 border-red-500/50 text-red-200'
            : toast.type === 'warning'
            ? 'bg-amber-950/90 border-amber-500/50 text-amber-200'
            : 'bg-emerald-950/90 border-emerald-500/50 text-emerald-200'
        }`}>
          {toast.type === 'error' ? <XCircle className="w-5 h-5" /> : <CheckCircle2 className="w-5 h-5" />}
          <span>{toast.message}</span>
        </div>
      )}

      {/* Top Navbar */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-500 flex items-center justify-center shadow-lg shadow-cyan-500/20 text-white font-bold text-xl">
              ⚡
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-lg tracking-tight bg-gradient-to-r from-cyan-400 via-sky-300 to-blue-400 bg-clip-text text-transparent">
                  Paystack Multi-Site Proxy
                </span>
                <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-cyan-950/80 text-cyan-300 border border-cyan-800/60">
                  Next.js Modern UI
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Webhook Dispatcher • High-Concurrency Router • Self-Healing Retries
              </p>
            </div>
          </div>

          {authToken && (
            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs">
                <span className={`w-2.5 h-2.5 rounded-full ${stats ? 'bg-emerald-400 animate-pulse' : 'bg-red-500'}`} />
                <span className="text-slate-300 font-mono">
                  {stats ? `Port ${stats.port} • ${stats.env}` : 'Offline'}
                </span>
              </div>

              <button
                onClick={() => setAutoRefresh(!autoRefresh)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition-colors ${
                  autoRefresh
                    ? 'bg-cyan-950/60 border-cyan-700/60 text-cyan-300'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
                title="Toggle Dashboard UI Auto-Refresh (Does NOT affect proxy forwarding)"
              >
                <Activity className={`w-3.5 h-3.5 ${autoRefresh ? 'animate-pulse text-cyan-400' : ''}`} />
                <span>{autoRefresh ? 'Live Sync (4s)' : 'Sync Paused'}</span>
              </button>

              <button
                onClick={() => {
                  fetchStatsAndEvents();
                  fetchSites();
                  fetchConfig();
                  showToastMsg('Dashboard data refreshed!');
                }}
                className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
                title="Refresh Data Now"
              >
                <RefreshCw className="w-4 h-4" />
              </button>

              <div className="flex items-center gap-2 pl-2 border-l border-slate-800">
                <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-cyan-950/40 border border-cyan-800/50 text-cyan-300 text-xs">
                  <User className="w-3.5 h-3.5 text-cyan-400" />
                  <span className="font-mono font-medium">{currentUser?.username || 'admin'}</span>
                </div>
                <button
                  onClick={handleLogout}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-red-950/40 hover:bg-red-900/60 border border-red-800/60 text-red-300 flex items-center gap-1.5 transition-colors"
                  title="Sign Out of Dashboard"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Sign Out</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Navigation Tabs - Only visible when authenticated */}
        {authToken && (
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex space-x-1 sm:space-x-4 overflow-x-auto no-scrollbar border-t border-slate-800/60">
            {[
              { id: 'overview', label: 'Overview & Metrics', icon: Activity },
              { id: 'events', label: 'Live Event Log & Queue', icon: Layers },
              { id: 'sites', label: 'Sites Manager', icon: Globe },
              { id: 'settings', label: 'Configuration & Settings', icon: Sliders },
              { id: 'simulator', label: 'Webhook Simulator', icon: Send },
              { id: 'verifier', label: 'Transaction Verifier', icon: ShieldCheck },
            ].map(tab => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => changeTab(tab.id)}
                  className={`flex items-center gap-2 py-3 px-3.5 text-xs sm:text-sm font-medium border-b-2 whitespace-nowrap transition-all ${
                    isActive
                      ? 'border-cyan-400 text-cyan-400 bg-cyan-950/20'
                      : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${isActive ? 'text-cyan-400' : 'text-slate-400'}`} />
                  <span>{tab.label}</span>
                  {tab.id === 'events' && (totalEvents > 0 || events.length > 0) && (
                    <span className="ml-1 px-1.5 py-0.2 text-[10px] rounded-full bg-slate-800 text-slate-300 font-mono">
                      {totalEvents || events.length}
                    </span>
                  )}
                  {tab.id === 'sites' && sites.length > 0 && (
                    <span className="ml-1 px-1.5 py-0.2 text-[10px] rounded-full bg-slate-800 text-slate-300 font-mono">
                      {sites.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {!authChecked ? (
          <div className="min-h-[50vh] flex flex-col items-center justify-center gap-3">
            <RefreshCw className="w-8 h-8 text-cyan-400 animate-spin" />
            <span className="text-sm text-slate-400 font-mono">Verifying administrator session...</span>
          </div>
        ) : !authToken ? (
          <div className="min-h-[70vh] flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-slate-900/90 border border-slate-800 rounded-2xl p-8 shadow-2xl backdrop-blur-xl relative overflow-hidden">
              <div className="absolute -top-20 -left-20 w-44 h-44 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
              <div className="absolute -bottom-20 -right-20 w-44 h-44 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />

              <div className="text-center mb-6 relative">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-cyan-600 via-sky-500 to-blue-600 flex items-center justify-center mx-auto mb-4 shadow-xl shadow-cyan-500/20 text-white">
                  <Lock className="w-7 h-7" />
                </div>
                <h2 className="text-2xl font-bold tracking-tight text-white">
                  Proxy Admin Sign In
                </h2>
                <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                  Authentication is required to view configurations, access sites management, and simulate webhook routes.
                </p>
              </div>

              {loginError && (
                <div className="mb-5 p-3.5 rounded-xl bg-red-950/80 border border-red-800/60 text-red-200 text-xs flex items-center gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                  <span>{loginError}</span>
                </div>
              )}

              <form onSubmit={handleLogin} className="space-y-4 relative">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
                    Admin Username
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                      <User className="w-4 h-4" />
                    </div>
                    <input
                      type="text"
                      required
                      value={loginForm.username}
                      onChange={e => setLoginForm(prev => ({ ...prev, username: e.target.value }))}
                      placeholder="e.g. admin"
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500 font-mono"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
                    Admin Password
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                      <Lock className="w-4 h-4" />
                    </div>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      value={loginForm.password}
                      onChange={e => setLoginForm(prev => ({ ...prev, password: e.target.value }))}
                      placeholder="••••••••••••"
                      className="w-full pl-10 pr-11 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-200 transition-colors"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loginLoading}
                  className="w-full mt-2 py-2.5 px-4 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-semibold text-sm shadow-lg shadow-cyan-500/25 flex items-center justify-center gap-2 transition-all transform active:scale-[0.98] disabled:opacity-50"
                >
                  {loginLoading ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Authenticating...</span>
                    </>
                  ) : (
                    <>
                      <span>Sign In to Dashboard</span>
                    </>
                  )}
                </button>
              </form>

              <div className="mt-6 pt-4 border-t border-slate-800/80 text-center">
                <p className="text-[11px] text-slate-500 flex items-center justify-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Secured with HMAC-SHA256 JWT & Rate Limiting</span>
                </p>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* ========================================================================= */}
            {/* TAB 1: OVERVIEW & METRICS                                                 */}
            {/* ========================================================================= */}
            {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* Paystack Integration Endpoints Card (Auto-Detected Domain) */}
            <div className="p-5 rounded-2xl bg-gradient-to-r from-slate-900/90 via-cyan-950/20 to-slate-900/90 border border-cyan-500/30 shadow-lg">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4 pb-3 border-b border-slate-800/80">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                    <Globe className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-bold text-sm text-slate-100 flex items-center gap-2">
                      Paystack Integration Endpoints
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-950 border border-cyan-700/60 text-cyan-300 font-mono font-normal">
                        Active Domain: {currentOrigin || 'Auto-Detecting...'}
                      </span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Copy and paste these two URLs into your{' '}
                      <a
                        href="https://dashboard.paystack.com/#/settings/developer"
                        target="_blank"
                        rel="noreferrer"
                        className="text-cyan-400 hover:underline inline-flex items-center gap-0.5 font-medium"
                      >
                        Paystack Dashboard (Settings &rarr; API Keys & Webhooks)
                        <ExternalLink className="w-3 h-3 ml-0.5" />
                      </a>
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Webhook URL */}
                <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                        <Zap className="w-3.5 h-3.5 text-cyan-400" /> Paystack Webhook URL
                      </span>
                      <span className="text-[10px] font-mono text-cyan-400 bg-cyan-950/80 border border-cyan-800/60 px-1.5 py-0.5 rounded font-bold">
                        POST
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 mb-2">
                      Where Paystack sends transaction events (e.g. <code className="text-slate-300">charge.success</code>).
                    </p>
                  </div>
                  <div className="flex items-center gap-2 bg-slate-900 px-3 py-2 rounded-lg border border-slate-800">
                    <input
                      type="text"
                      readOnly
                      value={paystackWebhookUrl}
                      className="bg-transparent text-xs font-mono text-cyan-300 w-full outline-none select-all"
                    />
                    <button
                      onClick={() => copyToClipboard(paystackWebhookUrl, 'Paystack Webhook URL')}
                      className="px-2.5 py-1 rounded bg-cyan-600/30 hover:bg-cyan-600/50 text-cyan-300 text-xs font-medium flex items-center gap-1 transition-all whitespace-nowrap"
                    >
                      <Copy className="w-3 h-3" /> Copy
                    </button>
                  </div>
                </div>

                {/* Callback URL */}
                <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                        <ArrowUpRight className="w-3.5 h-3.5 text-emerald-400" /> Paystack Callback URL
                      </span>
                      <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/80 border border-emerald-800/60 px-1.5 py-0.5 rounded font-bold">
                        GET
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 mb-2">
                      Where customer browsers are redirected after checkout to reach their child site.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 bg-slate-900 px-3 py-2 rounded-lg border border-slate-800">
                    <input
                      type="text"
                      readOnly
                      value={paystackCallbackUrl}
                      className="bg-transparent text-xs font-mono text-emerald-300 w-full outline-none select-all"
                    />
                    <button
                      onClick={() => copyToClipboard(paystackCallbackUrl, 'Paystack Callback URL')}
                      className="px-2.5 py-1 rounded bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 text-xs font-medium flex items-center gap-1 transition-all whitespace-nowrap"
                    >
                      <Copy className="w-3 h-3" /> Copy
                    </button>
                  </div>
                </div>
              </div>

              {/* Informational Webhook Secret Callout */}
              <div className="mt-3.5 pt-3 border-t border-slate-800/80 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-xs text-slate-400">
                <div className="flex items-start sm:items-center gap-2">
                  <Key className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5 sm:mt-0" />
                  <span>
                    <strong className="text-slate-200">Where is the Webhook Secret?</strong> Paystack signs all webhooks using your <strong className="text-cyan-300">Paystack Secret Key</strong> (<code className="text-slate-300">sk_live_...</code> or <code className="text-slate-300">sk_test_...</code>). Paystack does not have a separate webhook secret.
                  </span>
                </div>
              </div>
            </div>

            {/* Top Stat Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-9 gap-3 sm:gap-4">
              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800/80 shadow-sm hover:border-cyan-500/40 transition-colors">
                <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
                  <span>Ingested</span>
                  <Zap className="w-4 h-4 text-cyan-400" />
                </div>
                <div className="text-2xl font-bold font-mono text-cyan-300">
                  {stats?.metrics?.ingested ?? 0}
                </div>
                <span className="text-[11px] text-slate-500">Total webhooks in</span>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800/80 shadow-sm hover:border-emerald-500/40 transition-colors">
                <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
                  <span>Forwarded</span>
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="text-2xl font-bold font-mono text-emerald-400">
                  {stats?.metrics?.forwarded ?? 0}
                </div>
                <span className="text-[11px] text-slate-500">Delivered successfully</span>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800/80 shadow-sm hover:border-purple-500/40 transition-colors">
                <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
                  <span>Duplicates</span>
                  <Layers className="w-4 h-4 text-purple-400" />
                </div>
                <div className="text-2xl font-bold font-mono text-purple-300">
                  {stats?.metrics?.duplicates ?? 0}
                </div>
                <span className="text-[11px] text-slate-500">Idempotency deduplicated</span>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800/80 shadow-sm hover:border-amber-500/40 transition-colors">
                <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
                  <span>Retries</span>
                  <Clock className="w-4 h-4 text-amber-400" />
                </div>
                <div className="text-2xl font-bold font-mono text-amber-400">
                  {stats?.metrics?.retries ?? 0}
                </div>
                <span className="text-[11px] text-slate-500">{stats?.metrics?.queuedRetries ?? 0} active in queue</span>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800/80 shadow-sm hover:border-red-500/40 transition-colors">
                <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
                  <span>Dead Letters</span>
                  <AlertTriangle className="w-4 h-4 text-red-400" />
                </div>
                <div className="text-2xl font-bold font-mono text-red-400">
                  {stats?.metrics?.deadLetters ?? 0}
                </div>
                <span className="text-[11px] text-slate-500">Exceeded max attempts</span>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800/80 shadow-sm hover:border-rose-500/40 transition-colors">
                <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
                  <span>Unroutable</span>
                  <GitFork className="w-4 h-4 text-rose-400" />
                </div>
                <div className="text-2xl font-bold font-mono text-rose-400">
                  {stats?.metrics?.unroutable ?? 0}
                </div>
                <span className="text-[11px] text-slate-500">No rule matched</span>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800/80 shadow-sm hover:border-sky-500/40 transition-colors">
                <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
                  <span>Active Sites</span>
                  <Globe className="w-4 h-4 text-sky-400" />
                </div>
                <div className="text-2xl font-bold font-mono text-sky-300">
                  {stats?.sitesCount ?? sites.length}
                </div>
                <span className="text-[11px] text-slate-500">Routing targets</span>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800/80 shadow-sm hover:border-cyan-500/40 transition-colors">
                <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
                  <span>Avg Latency</span>
                  <Clock className="w-4 h-4 text-cyan-400" />
                </div>
                <div className="text-2xl font-bold font-mono text-cyan-300">
                  {stats?.metrics?.avgLatencyMs ?? 0}
                  <span className="text-xs font-normal text-slate-400 ml-1">ms</span>
                </div>
                <span className="text-[11px] text-slate-500">Downstream transit</span>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800/80 shadow-sm hover:border-emerald-500/40 transition-colors">
                <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
                  <span>Last Latency</span>
                  <Zap className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="text-2xl font-bold font-mono text-emerald-400">
                  {stats?.metrics?.lastLatencyMs ?? 0}
                  <span className="text-xs font-normal text-slate-400 ml-1">ms</span>
                </div>
                <span className="text-[11px] text-slate-500">Latest dispatch</span>
              </div>
            </div>

            {/* Health & Engine Status */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* System Overview */}
              <div className="p-5 rounded-2xl bg-slate-900/50 border border-slate-800 flex flex-col justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
                    <Server className="w-4 h-4 text-cyan-400" />
                    Runtime Status
                  </h3>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between py-1 border-b border-slate-800/60">
                      <span className="text-slate-400">Uptime</span>
                      <span className="font-mono text-slate-200">{stats?.uptimeHuman || 'Calculating...'}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-800/60">
                      <span className="text-slate-400">Node Runtime</span>
                      <span className="font-mono text-slate-200">{stats?.nodeVersion || 'v20+'}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-800/60">
                      <span className="text-slate-400">Queue Storage</span>
                      <span className="font-mono text-cyan-300 uppercase font-semibold px-2 py-0.5 rounded bg-cyan-950/60 border border-cyan-800/50">
                        {stats?.storageType || 'memory'}
                      </span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-800/60">
                      <span className="text-slate-400">IP Whitelisting</span>
                      <span className={`font-medium px-2 py-0.5 rounded text-[11px] border ${
                        stats?.ipWhitelistEnabled
                          ? 'text-emerald-400 bg-emerald-950/50 border-emerald-800/60'
                          : 'text-amber-400 bg-amber-950/50 border-amber-800/60'
                      }`}>
                        {stats?.ipWhitelistEnabled ? 'Enabled' : 'Disabled (Allow all)'}
                      </span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-800/60">
                      <span className="text-slate-400">Paystack API Secret</span>
                      <span className={`font-medium px-2 py-0.5 rounded text-[11px] border ${
                        stats?.secretConfigured
                          ? 'text-emerald-400 bg-emerald-950/50 border-emerald-800/60'
                          : 'text-red-400 bg-red-950/50 border-red-800/60'
                      }`}>
                        {stats?.secretConfigured ? 'Configured & Active' : 'Missing'}
                      </span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-800/60">
                      <span className="text-slate-400">Webhook HMAC Secret</span>
                      <span className={`font-medium px-2 py-0.5 rounded text-[11px] border ${
                        stats?.webhookSecretConfigured
                          ? 'text-emerald-400 bg-emerald-950/50 border-emerald-800/60'
                          : 'text-cyan-400 bg-cyan-950/50 border-cyan-800/60'
                      }`}>
                        {stats?.webhookSecretConfigured ? 'Dedicated Secret' : 'Active (API Key)'}
                      </span>
                    </div>
                    <div className="flex justify-between py-1">
                      <span className="text-slate-400">Database Store</span>
                      <span className={`font-medium px-2 py-0.5 rounded text-[11px] border ${
                        stats?.databaseConfigured
                          ? 'text-emerald-400 bg-emerald-950/50 border-emerald-800/60'
                          : 'text-slate-400 bg-slate-900 border-slate-800'
                      }`}>
                        {stats?.databaseConfigured ? 'PostgreSQL Attached' : 'Local / Memory'}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-500">
                  <span>Last check: {stats?.timestamp ? new Date(stats.timestamp).toLocaleTimeString() : 'N/A'}</span>
                  <span className="text-emerald-400 font-medium">Healthy</span>
                </div>
              </div>

              {/* Memory Usage */}
              <div className="p-5 rounded-2xl bg-slate-900/50 border border-slate-800">
                <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
                  <Cpu className="w-4 h-4 text-cyan-400" />
                  Memory & Resource Footprint
                </h3>
                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between text-xs text-slate-400 mb-1">
                      <span>Heap Used</span>
                      <span className="font-mono text-slate-200">{stats?.memory?.heapUsedMb || '0'} MB / {stats?.memory?.heapTotalMb || '0'} MB</span>
                    </div>
                    <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-cyan-500 h-2 rounded-full transition-all duration-500"
                        style={{
                          width: `${Math.min(
                            100,
                            stats?.memory?.heapPercent ?? Math.round(((stats?.memory?.heapUsedBytes || 1) / (stats?.memory?.heapTotalBytes || 1)) * 100)
                          )}%`,
                        }}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between text-xs text-slate-400 mb-1">
                      <span>Resident Set (RSS)</span>
                      <span className="font-mono text-slate-200">
                        {stats?.memory?.rssMb || '0'} MB {stats?.memory?.heapLimitMb ? `(Max: ${stats.memory.heapLimitMb} MB)` : ''}
                      </span>
                    </div>
                    <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-blue-500 h-2 rounded-full transition-all duration-500"
                        style={{
                          width: `${Math.min(
                            100,
                            stats?.memory?.rssPercent ?? Math.min(100, Math.max(5, Math.round(((stats?.memory?.rssBytes || 1) / (stats?.memory?.heapLimitBytes || (1024 * 1024 * 1024))) * 100)))
                          )}%`,
                        }}
                      />
                    </div>
                  </div>

                  <div className="pt-2 text-xs text-slate-400 space-y-1">
                    <p className="flex justify-between">
                      <span>Active Jobs:</span>
                      <span className="font-mono text-cyan-300 font-bold">{stats?.metrics?.activeJobs ?? 0}</span>
                    </p>
                    <p className="flex justify-between">
                      <span>Queued Retries:</span>
                      <span className="font-mono text-amber-300 font-bold">{stats?.metrics?.queuedRetries ?? 0}</span>
                    </p>
                  </div>
                </div>
              </div>

              {/* Callback Routing Summary */}
              <div className="p-5 rounded-2xl bg-slate-900/50 border border-slate-800">
                <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
                  <Radio className="w-4 h-4 text-cyan-400" />
                  Callbacks & Reverse Proxy
                </h3>
                <div className="space-y-3">
                  <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80 flex items-center justify-between">
                    <div>
                      <div className="text-xs text-slate-400">Total User Callbacks</div>
                      <div className="text-xl font-mono font-bold text-slate-100">{stats?.metrics?.callbacksTotal ?? 0}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-emerald-400">{stats?.metrics?.callbacksSuccess ?? 0} verified</div>
                      <div className="text-xs text-red-400">{stats?.metrics?.callbacksFailed ?? 0} failed</div>
                    </div>
                  </div>

                  <div className="text-xs text-slate-400 space-y-2">
                    <p>
                      The proxy handles both server-to-server webhook ingestion and browser payment callback redirection with automatic signature validation and reference prefix resolution.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setActiveTab('simulator')}
                        className="px-2.5 py-1 text-xs bg-cyan-950/60 border border-cyan-700/60 text-cyan-300 rounded hover:bg-cyan-900/50 transition-colors"
                      >
                        Launch Simulator →
                      </button>
                      <button
                        onClick={() => setActiveTab('settings')}
                        className="px-2.5 py-1 text-xs bg-slate-800 border border-slate-700 text-slate-300 rounded hover:bg-slate-700 transition-colors"
                      >
                        Adjust Config →
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Quick Recent Activity Banner */}
            <div className="p-4 rounded-xl bg-gradient-to-r from-slate-900 via-slate-900/90 to-slate-950 border border-slate-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <h4 className="text-sm font-medium text-slate-200">
                  Ready to test dispatch routing?
                </h4>
                <p className="text-xs text-slate-400">
                  Simulate real Paystack payloads like <code className="text-cyan-400">charge.success</code> and <code className="text-cyan-400">subscription.create</code> with automatically signed HMAC SHA512 tokens.
                </p>
              </div>
              <button
                onClick={() => setActiveTab('simulator')}
                className="px-4 py-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white rounded-lg text-xs font-semibold shadow-lg shadow-cyan-600/20 transition-all"
              >
                Open Webhook Simulator
              </button>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* TAB 2: LIVE EVENT LOG & QUEUE                                             */}
        {/* ========================================================================= */}
        {activeTab === 'events' && (
          <div className="space-y-4">
            {/* Filter Bar */}
            <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-3">
              <div className="flex flex-col md:flex-row items-center justify-between gap-3">
                {/* Search input with clear button */}
                <div className="relative w-full md:w-80">
                  <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search reference, site, event, error..."
                    value={eventsFilter}
                    onChange={e => setEventsFilter(e.target.value)}
                    className="w-full pl-9 pr-8 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                  />
                  {eventsFilter && (
                    <button
                      onClick={() => {
                        setEventsFilter('');
                        handleResetFilters();
                      }}
                      className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-200"
                      title="Clear search"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Site selector dropdown & action buttons */}
                <div className="flex items-center gap-2 w-full md:w-auto">
                  <span className="text-xs text-slate-400 whitespace-nowrap hidden sm:inline">Site:</span>
                  <select
                    value={siteFilter}
                    onChange={e => handleSiteFilterChange(e.target.value)}
                    className="bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 px-3 py-2 focus:outline-none focus:border-cyan-500 w-full sm:w-auto"
                  >
                    <option value="ALL">All Child Sites</option>
                    {sites.map(s => (
                      <option key={s.key} value={s.key}>
                        {s.name ? `${s.name} (${s.key})` : s.key}
                      </option>
                    ))}
                  </select>

                  {/* Reset filters button */}
                  {(eventsFilter || statusFilter !== 'ALL' || siteFilter !== 'ALL') && (
                    <button
                      onClick={handleResetFilters}
                      className="px-2.5 py-2 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap"
                      title="Reset all filters"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Reset</span>
                    </button>
                  )}

                  {/* Refresh button */}
                  <button
                    onClick={() => fetchEventsData()}
                    disabled={eventsLoading}
                    className="p-2 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors flex items-center justify-center disabled:opacity-50"
                    title="Refresh events list"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${eventsLoading ? 'animate-spin text-cyan-400' : ''}`} />
                  </button>

                  {/* Purge logs button */}
                  <button
                    onClick={handlePurgeOldLogs}
                    disabled={purgingLogs}
                    className="px-2.5 py-2 text-xs bg-slate-800/80 hover:bg-rose-950/40 hover:text-rose-300 hover:border-rose-800/50 border border-slate-700/60 text-slate-300 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                    title={`Prune event logs older than ${configData.proxy.logRetentionDays || 30} days`}
                  >
                    <Trash2 className={`w-3.5 h-3.5 text-rose-400 ${purgingLogs ? 'animate-spin' : ''}`} />
                    <span className="hidden md:inline">Purge &gt;{configData.proxy.logRetentionDays || 30}d</span>
                  </button>
                </div>
              </div>

              {/* Status Filter Pills */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
                <span className="text-xs text-slate-400 whitespace-nowrap mr-1 flex items-center gap-1">
                  <Filter className="w-3 h-3" /> Status:
                </span>
                {[
                  { id: 'ALL', label: 'All Statuses' },
                  { id: 'SUCCESS', label: 'Delivered / Success' },
                  { id: 'PROCESSING', label: 'Processing' },
                  { id: 'QUEUED', label: 'Queued' },
                  { id: 'RETRYING', label: 'Retrying' },
                  { id: 'DUPLICATE', label: 'Duplicate' },
                  { id: 'DEAD_LETTER', label: 'Dead Letter' },
                  { id: 'UNROUTABLE', label: 'Unroutable' },
                ].map(st => {
                  const isActive =
                    statusFilter === st.id ||
                    (st.id === 'SUCCESS' && statusFilter === 'FORWARDED');
                  return (
                    <button
                      key={st.id}
                      onClick={() => handleStatusFilterChange(st.id)}
                      className={`px-2.5 py-1 text-xs rounded-lg font-medium whitespace-nowrap transition-colors ${
                        isActive
                          ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                          : 'bg-slate-950 text-slate-400 border border-slate-800 hover:text-slate-200'
                      }`}
                    >
                      {st.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Event List Table */}
            <div className="rounded-xl bg-slate-900/60 border border-slate-800 overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-950/70 border-b border-slate-800 text-slate-400">
                    <tr>
                      <th className="py-3 px-4 font-semibold">Timestamp</th>
                      <th className="py-3 px-4 font-semibold">Event</th>
                      <th className="py-3 px-4 font-semibold">Reference</th>
                      <th className="py-3 px-4 font-semibold">Target Site</th>
                      <th className="py-3 px-4 font-semibold">Status</th>
                      <th className="py-3 px-4 font-semibold">HTTP</th>
                      <th className="py-3 px-4 font-semibold">Attempts</th>
                      <th className="py-3 px-4 text-right font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {filteredEvents.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-12 text-center text-slate-500">
                          <Layers className="w-8 h-8 mx-auto mb-2 opacity-30" />
                          <p>No webhook events recorded yet.</p>
                          <p className="text-[11px] text-slate-600 mt-1">
                            Send Paystack webhooks or use the Webhook Simulator to generate traffic.
                          </p>
                        </td>
                      </tr>
                    ) : (
                      filteredEvents.map(ev => {
                        const isSuccess = ev.status === 'FORWARDED' || ev.status === 'SUCCESS';
                        const isDuplicate = ev.status === 'DUPLICATE';
                        const isUnroutable = ev.status === 'UNROUTABLE';
                        const isDeadLetter = ev.status === 'DEAD_LETTER';
                        const isRetrying = ev.status === 'RETRYING';
                        const timeDisplay = (ev.createdAt || ev.timestamp)
                          ? new Date(ev.createdAt || ev.timestamp).toLocaleTimeString()
                          : 'N/A';

                        return (
                          <tr key={ev.id || ev.eventKey} className="hover:bg-slate-850/50 transition-colors">
                            <td className="py-3 px-4 text-slate-400 whitespace-nowrap font-mono text-[11px]">
                              {timeDisplay}
                            </td>
                            <td className="py-3 px-4 font-semibold text-slate-200">
                              <span className="font-mono text-cyan-400">{ev.eventType || 'paystack.event'}</span>
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-300">
                              {ev.reference || ev.eventKey?.split(':')[1] || 'N/A'}
                            </td>
                            <td className="py-3 px-4">
                              {ev.siteKey ? (
                                <span className="px-2 py-0.5 rounded bg-blue-950/60 text-blue-300 border border-blue-800/40 text-[11px] font-mono">
                                  {ev.siteKey}
                                </span>
                              ) : (
                                <span className="text-slate-500 italic">None</span>
                              )}
                            </td>
                            <td className="py-3 px-4">
                              <span
                                className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${
                                  isSuccess
                                    ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800/60'
                                    : isDuplicate
                                    ? 'bg-purple-950/60 text-purple-300 border-purple-800/60'
                                    : isUnroutable
                                    ? 'bg-amber-950/60 text-amber-300 border-amber-800/60'
                                    : isDeadLetter
                                    ? 'bg-red-950/60 text-red-300 border-red-800/60'
                                    : isRetrying
                                    ? 'bg-yellow-950/60 text-yellow-300 border-yellow-800/60'
                                    : 'bg-cyan-950/60 text-cyan-300 border-cyan-800/60'
                                }`}
                              >
                                {ev.status}
                              </span>
                            </td>
                            <td className="py-3 px-4 font-mono text-[11px]">
                              {ev.httpStatus ? (
                                <span
                                  className={`px-1.5 py-0.5 rounded font-semibold border ${
                                    ev.httpStatus >= 200 && ev.httpStatus < 300
                                      ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800/60'
                                      : 'bg-red-950/60 text-red-300 border-red-800/60'
                                  }`}
                                >
                                  {ev.httpStatus}
                                </span>
                              ) : (
                                <span className="text-slate-600">-</span>
                              )}
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-300">
                              {ev.attempts ?? 1}
                            </td>
                            <td className="py-3 px-4 text-right">
                              <button
                                onClick={() => setSelectedEvent(ev)}
                                className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs transition-colors"
                              >
                                View Details
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pagination Controls Bar */}
            <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-400">
              {/* Left: Summary and Page Size */}
              <div className="flex items-center gap-3">
                <span>
                  Showing{' '}
                  <strong className="text-slate-200">
                    {totalEvents > 0 ? (eventsPage - 1) * eventsPageSize + 1 : 0}
                  </strong>{' '}
                  to{' '}
                  <strong className="text-slate-200">
                    {Math.min(eventsPage * eventsPageSize, totalEvents)}
                  </strong>{' '}
                  of <strong className="text-slate-200">{totalEvents}</strong> events
                </span>

                <div className="flex items-center gap-1.5 border-l border-slate-800 pl-3">
                  <span>Show</span>
                  <select
                    value={eventsPageSize}
                    onChange={e => handlePageSizeChange(Number(e.target.value))}
                    className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200 focus:outline-none focus:border-cyan-500 text-xs"
                  >
                    <option value={10}>10</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                  <span>/ page</span>
                </div>
              </div>

              {/* Right: Page Navigation */}
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handlePageChange(1)}
                  disabled={eventsPage <= 1}
                  className="p-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="First page"
                >
                  <ChevronsLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handlePageChange(eventsPage - 1)}
                  disabled={eventsPage <= 1}
                  className="p-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="Previous page"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>

                <div className="flex items-center gap-1 px-1">
                  {Array.from({ length: totalEventPages }, (_, i) => i + 1)
                    .filter(p => {
                      if (totalEventPages <= 7) return true;
                      if (p === 1 || p === totalEventPages) return true;
                      return Math.abs(p - eventsPage) <= 1;
                    })
                    .reduce((acc, p, idx, arr) => {
                      if (idx > 0 && p - arr[idx - 1] > 1) {
                        acc.push(-1 * p); // gap marker
                      }
                      acc.push(p);
                      return acc;
                    }, [])
                    .map(p => {
                      if (p < 0) {
                        return (
                          <span key={`gap-${p}`} className="px-1 text-slate-600">
                            …
                          </span>
                        );
                      }
                      const isCurrent = p === eventsPage;
                      return (
                        <button
                          key={p}
                          onClick={() => handlePageChange(p)}
                          className={`w-7 h-7 rounded-lg text-xs font-medium transition-colors ${
                            isCurrent
                              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold'
                              : 'bg-slate-950 text-slate-400 border border-slate-800 hover:bg-slate-800 hover:text-slate-200'
                          }`}
                        >
                          {p}
                        </button>
                      );
                    })}
                </div>

                <button
                  onClick={() => handlePageChange(eventsPage + 1)}
                  disabled={eventsPage >= totalEventPages}
                  className="p-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="Next page"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handlePageChange(totalEventPages)}
                  disabled={eventsPage >= totalEventPages}
                  className="p-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="Last page"
                >
                  <ChevronsRight className="w-4 h-4" />
                </button>
              </div>
            </div>
            {selectedEvent && (
              <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
                <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
                  <div className="p-4 border-b border-slate-800 flex items-center justify-between">
                    <div>
                      <h3 className="font-semibold text-slate-100 flex items-center gap-2">
                        <span>Event Inspector</span>
                        <span className="text-xs font-mono text-cyan-400">
                          {selectedEvent.eventType || selectedEvent.eventKey}
                        </span>
                      </h3>
                      <p className="text-xs text-slate-400">Correlation ID: {selectedEvent.correlationId || 'N/A'}</p>
                    </div>
                    <button
                      onClick={() => setSelectedEvent(null)}
                      className="p-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"
                    >
                      <XCircle className="w-5 h-5" />
                    </button>
                  </div>

                  <div className="p-4 overflow-y-auto space-y-4 text-xs font-mono">
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 bg-slate-950 p-3 rounded-lg border border-slate-800/80">
                      <div>
                        <span className="text-slate-500">Status:</span>{' '}
                        <span className="text-cyan-400 font-bold">{selectedEvent.status}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Target Site:</span>{' '}
                        <span className="text-slate-200">{selectedEvent.siteKey || 'Unresolved'}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Reference:</span>{' '}
                        <span className="text-slate-200">{selectedEvent.reference || 'N/A'}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">HTTP Status:</span>{' '}
                        <span className={selectedEvent.httpStatus >= 200 && selectedEvent.httpStatus < 300 ? 'text-emerald-400 font-bold' : 'text-slate-300'}>
                          {selectedEvent.httpStatus || 'N/A'}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500">Attempts:</span>{' '}
                        <span className="text-slate-200">{selectedEvent.attempts ?? 1}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Latency:</span>{' '}
                        <span className="text-cyan-300">
                          {typeof selectedEvent.durationMs === 'number' ? `${selectedEvent.durationMs}ms` : 'N/A'}
                        </span>
                      </div>
                    </div>

                    {selectedEvent.error && (
                      <div className="p-3 rounded-lg bg-red-950/40 border border-red-800/60 text-red-300">
                        <span className="font-bold">Error:</span> {selectedEvent.error}
                      </div>
                    )}

                    <div>
                      <div className="flex justify-between items-center mb-1 text-slate-400">
                        <span>Full Raw Event Object</span>
                        <button
                          onClick={() => copyToClipboard(JSON.stringify(selectedEvent, null, 2), 'Event payload')}
                          className="flex items-center gap-1 text-[11px] text-cyan-400 hover:underline"
                        >
                          <Copy className="w-3 h-3" /> Copy JSON
                        </button>
                      </div>
                      <pre className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 overflow-x-auto text-[11px] leading-relaxed">
                        {JSON.stringify(selectedEvent, null, 2)}
                      </pre>
                    </div>
                  </div>

                  <div className="p-4 border-t border-slate-800 flex justify-end">
                    <button
                      onClick={() => setSelectedEvent(null)}
                      className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ========================================================================= */}
        {/* TAB 3: SITES MANAGER                                                      */}
        {/* ========================================================================= */}
        {activeTab === 'sites' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <h3 className="text-lg font-bold text-slate-100">Child Site Registry</h3>
                <p className="text-xs text-slate-400">
                  Manage child web apps, stores, and backend listeners. Changes are dynamically persisted to <code className="text-cyan-400">config/sites.json</code>.
                </p>
              </div>
              <button
                onClick={handleOpenAddSite}
                className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-cyan-600/20 transition-all"
              >
                <Plus className="w-4 h-4" /> Add Child Site
              </button>
            </div>

            {/* Paystack URLs Quick Reference Banner */}
            <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 text-xs">
              <div className="flex items-center gap-2 text-slate-300">
                <Globe className="w-4 h-4 text-cyan-400 flex-shrink-0" />
                <span>
                  <strong>Paystack Webhook URL:</strong> <code className="text-cyan-300 bg-slate-950 px-2 py-0.5 rounded font-mono select-all">{paystackWebhookUrl}</code>
                </span>
                <button
                  onClick={() => copyToClipboard(paystackWebhookUrl, 'Paystack Webhook URL')}
                  className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-cyan-300 transition-colors"
                  title="Copy Webhook URL"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="flex items-center gap-2 text-slate-300">
                <ArrowUpRight className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                <span>
                  <strong>Paystack Callback URL:</strong> <code className="text-emerald-300 bg-slate-950 px-2 py-0.5 rounded font-mono select-all">{paystackCallbackUrl}</code>
                </span>
                <button
                  onClick={() => copyToClipboard(paystackCallbackUrl, 'Paystack Callback URL')}
                  className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-emerald-300 transition-colors"
                  title="Copy Callback URL"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Sites Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {sites.map(site => {
                const ping = pingResults[site.key];
                const isPinging = pingingKey === site.key;

                return (
                  <div
                    key={site.key}
                    className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 hover:border-slate-700 transition-all flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-base text-slate-100">{site.name || site.key}</span>
                            <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-cyan-950 text-cyan-300 border border-cyan-800">
                              {site.key}
                            </span>
                          </div>
                          {site.hasSecret && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400 mt-1">
                              <ShieldCheck className="w-3 h-3" /> Shared secret configured
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleOpenEditSite(site)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
                            title="Edit Site"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteSite(site.key)}
                            className="p-1.5 rounded-lg text-red-400 hover:text-red-300 hover:bg-red-950/40 transition-colors"
                            title="Delete Site"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      <div className="space-y-2 text-xs">
                        <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80">
                          <span className="text-slate-500 block text-[10px] uppercase font-semibold">Downstream Webhook URL</span>
                          <span className="font-mono text-cyan-300 break-all select-all">{site.webhookUrl}</span>
                        </div>

                        {site.callbackUrl && (
                          <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80">
                            <span className="text-slate-500 block text-[10px] uppercase font-semibold">Default Redirect / Callback URL</span>
                            <span className="font-mono text-slate-300 break-all select-all">{site.callbackUrl}</span>
                          </div>
                        )}

                        {site.referencePrefixes && site.referencePrefixes.length > 0 && (
                          <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80">
                            <span className="text-slate-500 block text-[10px] uppercase font-semibold mb-1">Reference Prefixes</span>
                            <div className="flex flex-wrap gap-1">
                              {site.referencePrefixes.map(p => (
                                <span key={p} className="px-2 py-0.5 rounded text-[11px] font-mono bg-blue-950/70 text-blue-300 border border-blue-800/50">
                                  {p}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {site.referencePatterns && site.referencePatterns.length > 0 && (
                          <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80">
                            <span className="text-slate-500 block text-[10px] uppercase font-semibold mb-1">Reference Regex Patterns</span>
                            <div className="flex flex-wrap gap-1">
                              {site.referencePatterns.map(pat => (
                                <span key={pat} className="px-2 py-0.5 rounded text-[11px] font-mono bg-indigo-950/70 text-indigo-300 border border-indigo-800/50">
                                  {pat}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {site.flowRoutes && Object.keys(site.flowRoutes).length > 0 && (
                          <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80">
                            <span className="text-slate-500 block text-[10px] uppercase font-semibold mb-1">Flow Callback Routes</span>
                            <div className="space-y-1">
                              {Object.entries(site.flowRoutes).map(([flow, url]) => (
                                <div key={flow} className="flex items-center gap-1.5 text-[11px]">
                                  <span className="px-1.5 py-0.5 rounded font-mono bg-emerald-950 text-emerald-300 border border-emerald-800 text-[10px]">
                                    {flow}
                                  </span>
                                  <span className="font-mono text-slate-400 truncate select-all">{url}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="mt-4 pt-3 border-t border-slate-800/60 flex items-center justify-between">
                      <div>
                        {ping && (
                          <span
                            className={`text-xs font-medium inline-flex items-center gap-1 ${
                              ping.reachable ? 'text-emerald-400' : 'text-red-400'
                            }`}
                          >
                            {ping.reachable ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                            <span>{ping.reachable ? `Reachable (${ping.durationMs}ms)` : 'Unreachable'}</span>
                          </span>
                        )}
                      </div>

                      <button
                        onClick={() => handlePingSite(site.key)}
                        disabled={isPinging}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isPinging ? 'animate-spin' : ''}`} />
                        <span>{isPinging ? 'Pinging...' : 'Test Reachability'}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Site Add/Edit Modal */}
            {siteModalOpen && (
              <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
                <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
                  <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
                    <h3 className="font-bold text-base text-slate-100">
                      {editingSite ? `Edit Child Site: ${editingSite}` : 'Add New Child Site'}
                    </h3>
                    <button
                      onClick={() => setSiteModalOpen(false)}
                      className="text-slate-400 hover:text-slate-100"
                    >
                      <XCircle className="w-5 h-5" />
                    </button>
                  </div>

                  <form onSubmit={handleSaveSite} className="space-y-4 text-xs">
                    <div>
                      <label className="block text-slate-300 font-medium mb-1">
                        Site Key (unique ID e.g. <span className="text-cyan-400">lufak</span>, <span className="text-cyan-400">saas</span>)
                      </label>
                      <input
                        type="text"
                        required
                        value={siteForm.key}
                        onChange={e => setSiteForm({ ...siteForm, key: e.target.value })}
                        placeholder="e.g. ecommerce"
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                      />
                    </div>

                    <div>
                      <label className="block text-slate-300 font-medium mb-1">Display Name</label>
                      <input
                        type="text"
                        value={siteForm.name}
                        onChange={e => setSiteForm({ ...siteForm, name: e.target.value })}
                        placeholder="e.g. My E-Commerce Store"
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 focus:outline-none focus:border-cyan-500"
                      />
                    </div>

                    <div>
                      <label className="block text-slate-300 font-medium mb-1">
                        Downstream Webhook URL (Required)
                      </label>
                      <input
                        type="url"
                        required
                        value={siteForm.webhookUrl}
                        onChange={e => setSiteForm({ ...siteForm, webhookUrl: e.target.value })}
                        placeholder="https://store.example.com/api/v1/paystack/webhook"
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                      />
                    </div>

                    <div>
                      <label className="block text-slate-300 font-medium mb-1">
                        Default Callback Redirection URL (Optional)
                      </label>
                      <input
                        type="url"
                        value={siteForm.callbackUrl}
                        onChange={e => setSiteForm({ ...siteForm, callbackUrl: e.target.value })}
                        placeholder="https://store.example.com/checkout/complete"
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                      />
                    </div>

                    <div>
                      <label className="block text-slate-300 font-medium mb-1">
                        Reference Prefixes (Comma-separated, e.g. <span className="text-cyan-400">tsk_wallet, tsk_store, topup</span>)
                      </label>
                      <input
                        type="text"
                        value={siteForm.referencePrefixes}
                        onChange={e => setSiteForm({ ...siteForm, referencePrefixes: e.target.value })}
                        placeholder="tsk_wallet, tsk_store, tsk_data"
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                      />
                      <p className="text-[11px] text-slate-500 mt-1">Incoming payments with references starting with these prefixes route to this site.</p>
                    </div>

                    <div>
                      <label className="block text-slate-300 font-medium mb-1">
                        Reference Regex / Glob Patterns (Comma-separated, e.g. <span className="text-cyan-400">^tsk_(wallet|store)_.*, ^gh_.*</span>)
                      </label>
                      <input
                        type="text"
                        value={siteForm.referencePatterns}
                        onChange={e => setSiteForm({ ...siteForm, referencePatterns: e.target.value })}
                        placeholder="^tsk_(wallet|store)_.*, ^gh_.*"
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                      />
                      <p className="text-[11px] text-slate-500 mt-1">Smart patterns safely matched against incoming transaction references.</p>
                    </div>

                    <div className="pt-2 border-t border-slate-800/80 space-y-3">
                      <div className="flex items-center gap-1.5 text-slate-200 font-semibold">
                        <GitFork className="w-4 h-4 text-cyan-400" />
                        <span>Dedicated Flow Callback Routes (Optional)</span>
                      </div>

                      <div>
                        <label className="block text-slate-300 font-medium mb-1">
                          Wallet Top-Up Callback URL (<span className="text-emerald-400">flow: wallet</span>)
                        </label>
                        <input
                          type="url"
                          value={siteForm.walletCallbackUrl}
                          onChange={e => setSiteForm({ ...siteForm, walletCallbackUrl: e.target.value })}
                          placeholder="https://store.example.com/dashboard/wallet/success"
                          className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                        />
                      </div>

                      <div>
                        <label className="block text-slate-300 font-medium mb-1">
                          Storefront Checkout Callback URL (<span className="text-emerald-400">flow: checkout</span>)
                        </label>
                        <input
                          type="url"
                          value={siteForm.checkoutCallbackUrl}
                          onChange={e => setSiteForm({ ...siteForm, checkoutCallbackUrl: e.target.value })}
                          placeholder="https://store.example.com/store/order-complete"
                          className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                        />
                      </div>

                      <div>
                        <label className="block text-slate-300 font-medium mb-1">
                          Additional Custom Flow Routes (JSON, e.g. <span className="text-cyan-400">&#123;&quot;billing&quot;: &quot;https://...&quot;&#125;</span>)
                        </label>
                        <textarea
                          rows={2}
                          value={siteForm.otherFlows}
                          onChange={e => setSiteForm({ ...siteForm, otherFlows: e.target.value })}
                          placeholder='{"billing": "https://app.example.com/billing", "subscribe": "https://app.example.com/subscribe"}'
                          className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono text-[11px] focus:outline-none focus:border-cyan-500"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-slate-300 font-medium mb-1">
                        Site Secret Key (Optional - for x-proxy-signature HMAC verification)
                      </label>
                      <input
                        type="text"
                        value={siteForm.secret}
                        onChange={e => setSiteForm({ ...siteForm, secret: e.target.value })}
                        placeholder="custom_internal_secret_for_this_site"
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                      />
                    </div>

                    <div className="pt-3 border-t border-slate-800 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setSiteModalOpen(false)}
                        className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg font-medium"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg font-medium shadow-md shadow-cyan-600/20"
                      >
                        {editingSite ? 'Save Changes' : 'Create Site'}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ========================================================================= */}
        {/* TAB 4: CONFIGURATION & SETTINGS PANEL                                     */}
        {/* ========================================================================= */}
        {activeTab === 'settings' && (
          <div className="max-w-4xl space-y-6">
            <div className="p-4 rounded-xl bg-gradient-to-r from-cyan-950/40 to-blue-950/40 border border-cyan-800/40">
              <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <Sliders className="w-5 h-5 text-cyan-400" />
                Live Configuration & Environment Settings
              </h3>
              <p className="text-xs text-slate-300 mt-1">
                Everything here is configurable live from the dashboard. Changes are persisted to the database and applied immediately to the running server without needing a restart!
              </p>
            </div>

            <form onSubmit={handleSaveConfig} className="space-y-6 text-xs">
              {/* Paystack Credentials & Whitelist */}
              <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4">
                <h4 className="font-semibold text-slate-200 text-sm flex items-center gap-2 border-b border-slate-800 pb-2">
                  <ShieldCheck className="w-4 h-4 text-cyan-400" />
                  Paystack Ingestion Credentials
                </h4>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Paystack Secret Key (<code className="text-cyan-400">PAYSTACK_SECRET_KEY</code>)
                    </label>
                    <div className="relative">
                      <input
                        type={showPaystackSecret ? 'text' : 'password'}
                        value={configData.paystack.secretKey}
                        onChange={e =>
                          setConfigData({
                            ...configData,
                            paystack: { ...configData.paystack, secretKey: e.target.value },
                          })
                        }
                        placeholder="sk_live_... or sk_test_..."
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500 pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPaystackSecret(!showPaystackSecret)}
                        className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-200"
                      >
                        {showPaystackSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Paystack Webhook Secret (<code className="text-cyan-400">PAYSTACK_WEBHOOK_SECRET</code>)
                    </label>
                    <div className="relative">
                      <input
                        type={showWebhookSecret ? 'text' : 'password'}
                        value={configData.paystack.webhookSecret}
                        onChange={e =>
                          setConfigData({
                            ...configData,
                            paystack: { ...configData.paystack, webhookSecret: e.target.value },
                          })
                        }
                        placeholder="sk_live_... or sk_test_..."
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500 pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowWebhookSecret(!showWebhookSecret)}
                        className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-200"
                      >
                        {showWebhookSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                </div>

                {/* IP Whitelist Toggle & IPs */}
                <div className="pt-2 border-t border-slate-800/60 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-medium text-slate-200 block">
                        Enable Official Paystack IP Whitelist
                      </span>
                      <span className="text-[11px] text-slate-400">
                        When enabled, only HTTP requests from Paystack's official IP ranges will be accepted for webhook ingestion.
                      </span>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={configData.paystack.enableIpWhitelist}
                        onChange={e =>
                          setConfigData({
                            ...configData,
                            paystack: { ...configData.paystack, enableIpWhitelist: e.target.checked },
                          })
                        }
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-600"></div>
                    </label>
                  </div>

                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Allowed IP List (comma-separated)
                    </label>
                    <input
                      type="text"
                      value={
                        Array.isArray(configData.paystack.ipWhitelist)
                          ? configData.paystack.ipWhitelist.join(', ')
                          : configData.paystack.ipWhitelist || ''
                      }
                      onChange={e =>
                        setConfigData({
                          ...configData,
                          paystack: {
                            ...configData.paystack,
                            ipWhitelist: e.target.value.split(',').map(s => s.trim()),
                          },
                        })
                      }
                      placeholder="52.31.139.228, 52.214.14.220, 54.76.137.41"
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                </div>
              </div>

              {/* Proxy Security & Retry Engine */}
              <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4">
                <h4 className="font-semibold text-slate-200 text-sm flex items-center gap-2 border-b border-slate-800 pb-2">
                  <Activity className="w-4 h-4 text-cyan-400" />
                  Proxy Routing, Timeouts & Retry Schedule
                </h4>

                <div>
                  <label className="block text-slate-300 font-medium mb-1">
                    Proxy Internal Shared Secret (<code className="text-cyan-400">PROXY_SHARED_SECRET</code>)
                  </label>
                  <div className="relative">
                    <input
                      type={showProxySecret ? 'text' : 'password'}
                      value={configData.proxy.sharedSecret}
                      onChange={e =>
                        setConfigData({
                          ...configData,
                          proxy: { ...configData.proxy, sharedSecret: e.target.value },
                        })
                      }
                      placeholder="secure-shared-secret-key-for-downstream-sites"
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500 pr-20"
                    />
                    <div className="absolute right-2 top-2 flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setShowProxySecret(!showProxySecret)}
                        className="p-1 text-slate-400 hover:text-slate-200"
                      >
                        {showProxySecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(configData.proxy.sharedSecret, 'Proxy secret')}
                        className="p-1 text-slate-400 hover:text-slate-200"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <span className="text-[11px] text-slate-500">
                    Transmitted to downstream child sites in the <code className="text-slate-400">x-proxy-signature</code> header.
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Forwarding Timeout (ms)
                    </label>
                    <input
                      type="number"
                      value={configData.proxy.timeoutMs}
                      onChange={e =>
                        setConfigData({
                          ...configData,
                          proxy: { ...configData.proxy, timeoutMs: Number(e.target.value) },
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Max Retries
                    </label>
                    <input
                      type="number"
                      value={configData.proxy.maxRetries}
                      onChange={e =>
                        setConfigData({
                          ...configData,
                          proxy: { ...configData.proxy, maxRetries: Number(e.target.value) },
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Queue Storage Adapter
                    </label>
                    <select
                      value={configData.proxy.queueStore}
                      onChange={e =>
                        setConfigData({
                          ...configData,
                          proxy: { ...configData.proxy, queueStore: e.target.value },
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    >
                      <option value="memory">memory (in-RAM, fast)</option>
                      <option value="sqlite">sqlite (local database)</option>
                      <option value="redis">redis (distributed cluster)</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-slate-300 font-medium mb-1">
                    Retry Delays in ms (comma-separated: e.g. <span className="text-cyan-400">15000, 60000, 300000, 900000</span>)
                  </label>
                  <input
                    type="text"
                    value={
                      Array.isArray(configData.proxy.retryDelays)
                        ? configData.proxy.retryDelays.join(', ')
                        : configData.proxy.retryDelays || ''
                    }
                    onChange={e =>
                      setConfigData({
                        ...configData,
                        proxy: {
                          ...configData.proxy,
                          retryDelays: e.target.value.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n)),
                        },
                      })
                    }
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                  />
                  <span className="text-[11px] text-slate-500">
                    Defines exponential backoff intervals between downstream delivery attempts.
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-800/60">
                  {configData.proxy.queueStore === 'sqlite' && (
                    <div>
                      <label className="block text-slate-300 font-medium mb-1">
                        SQLite Database Path (<code className="text-cyan-400">SQLITE_DB_PATH</code>)
                      </label>
                      <input
                        type="text"
                        value={configData.proxy.sqliteDbPath || ''}
                        onChange={e =>
                          setConfigData({
                            ...configData,
                            proxy: { ...configData.proxy, sqliteDbPath: e.target.value },
                          })
                        }
                        placeholder="./data/proxy.db"
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                  )}

                  {configData.proxy.queueStore === 'redis' && (
                    <div>
                      <label className="block text-slate-300 font-medium mb-1">
                        Redis Connection URL (<code className="text-cyan-400">REDIS_URL</code>)
                      </label>
                      <input
                        type="text"
                        value={configData.proxy.redisUrl || ''}
                        onChange={e =>
                          setConfigData({
                            ...configData,
                            proxy: { ...configData.proxy, redisUrl: e.target.value },
                          })
                        }
                        placeholder="redis://127.0.0.1:6379/0"
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Idempotency TTL (seconds) (<code className="text-cyan-400">IDEMPOTENCY_TTL_SECONDS</code>)
                    </label>
                    <input
                      type="number"
                      value={configData.proxy.idempotencyTtlSeconds || 86400}
                      onChange={e =>
                        setConfigData({
                          ...configData,
                          proxy: { ...configData.proxy, idempotencyTtlSeconds: Number(e.target.value) },
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    />
                    <span className="text-[11px] text-slate-500">
                      Default: 86400s (24 hours). Prevents duplicate event ingestion.
                    </span>
                  </div>

                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Log Retention Period (days) (<code className="text-cyan-400">LOG_RETENTION_DAYS</code>)
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="365"
                      value={configData.proxy.logRetentionDays || 30}
                      onChange={e =>
                        setConfigData({
                          ...configData,
                          proxy: { ...configData.proxy, logRetentionDays: Number(e.target.value) },
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    />
                    <span className="text-[11px] text-slate-500">
                      Default: 30 days. Automatically prunes webhook event logs and expired idempotency records.
                    </span>
                  </div>
                </div>
              </div>

              {/* Alerting Notifications (Discord & Telegram) */}
              <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4">
                <h4 className="font-semibold text-slate-200 text-sm flex items-center gap-2 border-b border-slate-800 pb-2">
                  <Radio className="w-4 h-4 text-cyan-400" />
                  Dead-Letter & Failure Alert Hooks
                </h4>

                <div>
                  <label className="block text-slate-300 font-medium mb-1">
                    Discord Webhook URL
                  </label>
                  <input
                    type="url"
                    value={configData.notifications.discordWebhookUrl}
                    onChange={e =>
                      setConfigData({
                        ...configData,
                        notifications: { ...configData.notifications, discordWebhookUrl: e.target.value },
                      })
                    }
                    placeholder="https://discord.com/api/webhooks/..."
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                  />
                  <span className="text-[11px] text-slate-500">
                    Alerts Ops channel immediately when a webhook exceeds max retries or is completely unroutable.
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Telegram Bot Token
                    </label>
                    <input
                      type="text"
                      value={configData.notifications.telegram.botToken}
                      onChange={e =>
                        setConfigData({
                          ...configData,
                          notifications: {
                            ...configData.notifications,
                            telegram: { ...configData.notifications.telegram, botToken: e.target.value },
                          },
                        })
                      }
                      placeholder="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Telegram Chat ID
                    </label>
                    <input
                      type="text"
                      value={configData.notifications.telegram.chatId}
                      onChange={e =>
                        setConfigData({
                          ...configData,
                          notifications: {
                            ...configData.notifications,
                            telegram: { ...configData.notifications.telegram, chatId: e.target.value },
                          },
                        })
                      }
                      placeholder="-1001234567890"
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                </div>
              </div>

              {/* Server & Runtime Environment Settings */}
              <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4">
                <h4 className="font-semibold text-slate-200 text-sm flex items-center gap-2 border-b border-slate-800 pb-2">
                  <Server className="w-4 h-4 text-cyan-400" />
                  Server & Runtime Environment
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      HTTP Port (<code className="text-cyan-400">PORT</code>)
                    </label>
                    <input
                      type="number"
                      value={configData.server?.port || 3000}
                      onChange={e =>
                        setConfigData({
                          ...configData,
                          server: { ...configData.server, port: Number(e.target.value) },
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    />
                    <span className="text-[10px] text-slate-500 block mt-1">
                      Persisted to .env. Note: Rebinding the listening HTTP socket requires restarting the server process.
                    </span>
                  </div>

                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Log Level (<code className="text-cyan-400">LOG_LEVEL</code>)
                    </label>
                    <select
                      value={configData.server?.logLevel || 'info'}
                      onChange={e =>
                        setConfigData({
                          ...configData,
                          server: { ...configData.server, logLevel: e.target.value },
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    >
                      <option value="trace">trace (most verbose)</option>
                      <option value="debug">debug</option>
                      <option value="info">info (standard)</option>
                      <option value="warn">warn</option>
                      <option value="error">error</option>
                      <option value="fatal">fatal</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Environment (<code className="text-cyan-400">NODE_ENV</code>)
                    </label>
                    <select
                      value={configData.server?.env || 'development'}
                      onChange={e =>
                        setConfigData({
                          ...configData,
                          server: { ...configData.server, env: e.target.value },
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    >
                      <option value="development">development</option>
                      <option value="production">production</option>
                      <option value="test">test</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Sites Config Path (<code className="text-cyan-400">SITES_CONFIG_PATH</code>)
                    </label>
                    <input
                      type="text"
                      value={configData.server?.sitesConfigPath || './config/sites.json'}
                      onChange={e =>
                        setConfigData({
                          ...configData,
                          server: { ...configData.server, sitesConfigPath: e.target.value },
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                </div>
              </div>

              {/* Dashboard Security & Admin Credentials Settings */}
              <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4">
                <h4 className="font-semibold text-slate-200 text-sm flex items-center gap-2 border-b border-slate-800 pb-2">
                  <Lock className="w-4 h-4 text-cyan-400" />
                  Dashboard Authentication & Admin Credentials
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Admin Username (<code className="text-cyan-400">DASHBOARD_USERNAME</code>)
                    </label>
                    <input
                      type="text"
                      value={configData.dashboard?.username || 'admin'}
                      onChange={e =>
                        setConfigData({
                          ...configData,
                          dashboard: { ...configData.dashboard, username: e.target.value },
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Change Admin Password (<code className="text-cyan-400">DASHBOARD_PASSWORD</code>)
                    </label>
                    <input
                      type="password"
                      placeholder="Leave blank to keep unchanged"
                      value={configData.dashboard?.newPassword || ''}
                      onChange={e =>
                        setConfigData({
                          ...configData,
                          dashboard: { ...configData.dashboard, newPassword: e.target.value },
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    />
                    <span className="text-[10px] text-slate-500 block mt-1">
                      Enter new password or leave blank to keep current.
                    </span>
                  </div>

                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Session Duration (hours) (<code className="text-cyan-400">DASHBOARD_SESSION_HOURS</code>)
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="720"
                      value={configData.dashboard?.sessionHours || 24}
                      onChange={e =>
                        setConfigData({
                          ...configData,
                          dashboard: { ...configData.dashboard, sessionHours: Number(e.target.value) },
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-800/60 flex items-center justify-between">
                  <div>
                    <span className="text-slate-200 font-medium block">Enforce Dashboard Authentication</span>
                    <span className="text-slate-400 text-[11px]">
                      When enabled, access to all dashboard APIs and configuration requires signing in.
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={configData.dashboard?.authEnabled !== false}
                    onChange={e =>
                      setConfigData({
                        ...configData,
                        dashboard: { ...configData.dashboard, authEnabled: e.target.checked },
                      })
                    }
                    className="w-4 h-4 rounded text-cyan-500 focus:ring-cyan-500 bg-slate-950 border-slate-800"
                  />
                </div>
              </div>

              {/* Submit Button */}
              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={() => {
                    fetchConfig();
                    showToastMsg('Reloaded settings from server.');
                  }}
                  className="px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 transition-colors font-medium"
                >
                  Discard & Reload
                </button>

                <button
                  type="submit"
                  disabled={savingConfig}
                  className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-semibold shadow-lg shadow-cyan-600/30 flex items-center gap-2 transition-all disabled:opacity-50"
                >
                  <Check className="w-4 h-4" />
                  <span>{savingConfig ? 'Saving Settings...' : 'Save Configuration & Apply Live'}</span>
                </button>
              </div>
            </form>
          </div>
        )}

        {/* ========================================================================= */}
        {/* TAB 5: WEBHOOK SIMULATOR                                                  */}
        {/* ========================================================================= */}
        {activeTab === 'simulator' && (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-bold text-slate-100">Paystack Webhook Simulator</h3>
              <p className="text-xs text-slate-400">
                Generate authentic Paystack events, compute cryptographic HMAC SHA512 signatures, test routing logic, and inspect live downstream dispatching.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Simulator Form */}
              <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <span className="font-semibold text-sm text-slate-200">Event Parameters</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSimForm({ ...simForm, customPayloadMode: !simForm.customPayloadMode })}
                      className="text-xs text-cyan-400 hover:underline flex items-center gap-1"
                    >
                      <Code className="w-3.5 h-3.5" />
                      <span>{simForm.customPayloadMode ? 'Switch to Preset Form' : 'Raw JSON Mode'}</span>
                    </button>
                  </div>
                </div>

                <form onSubmit={handleSimulateWebhook} className="space-y-4 text-xs">
                  {simForm.customPayloadMode ? (
                    <div>
                      <label className="block text-slate-300 font-medium mb-1">
                        Raw Paystack JSON Webhook Body
                      </label>
                      <textarea
                        rows={12}
                        value={simForm.customPayload}
                        onChange={e => setSimForm({ ...simForm, customPayload: e.target.value })}
                        placeholder={`{\n  "event": "charge.success",\n  "data": {\n    "id": 998811,\n    "reference": "tsk_wallet_7788",\n    "amount": 5000,\n    "currency": "GHS",\n    "status": "success"\n  }\n}`}
                        className="w-full p-3 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 font-mono focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-slate-300 font-medium mb-1">Event Type</label>
                          <select
                            value={simForm.eventType}
                            onChange={e => setSimForm({ ...simForm, eventType: e.target.value })}
                            className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                          >
                            <option value="charge.success">charge.success (Payment Successful)</option>
                            <option value="subscription.create">subscription.create (New Subscription)</option>
                            <option value="subscription.disable">subscription.disable (Cancelled)</option>
                            <option value="invoice.create">invoice.create (Invoice Issued)</option>
                            <option value="transfer.success">transfer.success (Payout Sent)</option>
                            <option value="refund.processed">refund.processed (Refund Complete)</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-slate-300 font-medium mb-1">Target Site</label>
                          <select
                            value={simForm.siteKey}
                            onChange={e => setSimForm({ ...simForm, siteKey: e.target.value })}
                            className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                          >
                            {sites.map(s => (
                              <option key={s.key} value={s.key}>
                                {s.name || s.key} ({s.key})
                              </option>
                            ))}
                            <option value="">None / Unmatched (Tests fallback)</option>
                          </select>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-slate-300 font-medium mb-1">
                            Routing Mechanism
                          </label>
                          <select
                            value={simForm.routingMechanism}
                            onChange={e => setSimForm({ ...simForm, routingMechanism: e.target.value })}
                            className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 focus:outline-none focus:border-cyan-500"
                          >
                            <option value="both">Both (Prefix & Metadata)</option>
                            <option value="reference">Reference Prefix only (e.g. lufak_txn_...)</option>
                            <option value="metadata">Metadata origin_site only</option>
                            <option value="none">None (Random reference)</option>
                          </select>
                        </div>

                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <label className="block text-slate-300 font-medium">Amount (in Pesewas)</label>
                            <span className="text-[11px] text-cyan-400 font-mono">
                              GH₵ {(Number(simForm.amount || 0) / 100).toFixed(2)}
                            </span>
                          </div>
                          <input
                            type="number"
                            value={simForm.amount}
                            onChange={e => setSimForm({ ...simForm, amount: e.target.value })}
                            className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                          />
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {[
                              { label: 'GH₵ 50.00', pesewas: 5000 },
                              { label: 'GH₵ 100.00', pesewas: 10000 },
                              { label: 'GH₵ 250.00', pesewas: 25000 },
                              { label: 'GH₵ 500.00', pesewas: 50000 },
                              { label: 'GH₵ 1,000.00', pesewas: 100000 },
                            ].map(preset => (
                              <button
                                key={preset.pesewas}
                                type="button"
                                onClick={() => setSimForm({ ...simForm, amount: preset.pesewas })}
                                className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                                  Number(simForm.amount) === preset.pesewas
                                    ? 'bg-cyan-600/30 text-cyan-300 border-cyan-500'
                                    : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
                                }`}
                              >
                                {preset.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-slate-300 font-medium mb-1">Customer Email</label>
                          <input
                            type="email"
                            value={simForm.email}
                            onChange={e => setSimForm({ ...simForm, email: e.target.value })}
                            className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 focus:outline-none focus:border-cyan-500"
                          />
                        </div>

                        <div>
                          <label className="block text-slate-300 font-medium mb-1">Custom Reference (Optional)</label>
                          <input
                            type="text"
                            value={simForm.reference}
                            onChange={e => setSimForm({ ...simForm, reference: e.target.value })}
                            placeholder="Leave blank to auto-generate"
                            className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                          />
                        </div>
                      </div>
                    </>
                  )}

                  <button
                    type="submit"
                    disabled={simulating}
                    className="w-full py-2.5 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-semibold shadow-lg shadow-cyan-600/30 flex items-center justify-center gap-2 transition-all disabled:opacity-50"
                  >
                    <Send className={`w-4 h-4 ${simulating ? 'animate-spin' : ''}`} />
                    <span>{simulating ? 'Calculating Signature & Dispatching...' : 'Sign & Dispatch Webhook'}</span>
                  </button>
                </form>
              </div>

              {/* Simulation Result Viewer */}
              <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 flex flex-col justify-between">
                <div>
                  <h4 className="font-semibold text-slate-200 text-sm border-b border-slate-800 pb-3 mb-3">
                    Live Dispatch Feedback
                  </h4>

                  {!simResult ? (
                    <div className="py-16 text-center text-slate-500 text-xs">
                      <Terminal className="w-8 h-8 mx-auto mb-2 opacity-30" />
                      <p>No simulated dispatch executed yet.</p>
                      <p className="text-[11px] text-slate-600 mt-1">
                        Fill in parameters and click "Sign & Dispatch Webhook" to test routing.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-4 text-xs font-mono">
                      <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-between">
                        <div>
                          <span className="text-slate-500 text-[10px] block">RESOLUTION</span>
                          <span className="text-emerald-400 font-bold text-sm">
                            {simResult.unroutable ? 'UNROUTABLE' : `Routed to "${simResult.resolvedSite}"`}
                          </span>
                        </div>
                        <span className="px-2 py-1 rounded bg-slate-800 text-slate-300 text-[11px]">
                          Match: {simResult.matchType || 'none'}
                        </span>
                      </div>

                      {simResult.targetUrl && (
                        <div>
                          <span className="text-slate-500 text-[10px] block">TARGET DOWNSTREAM URL</span>
                          <span className="text-cyan-300 break-all select-all">{simResult.targetUrl}</span>
                        </div>
                      )}

                      <div>
                        <div className="flex justify-between items-center text-slate-500 text-[10px] mb-1">
                          <span>CALCULATED HMAC SHA512 SIGNATURE</span>
                          <button
                            onClick={() => copyToClipboard(simResult.signature, 'Signature')}
                            className="text-cyan-400 hover:underline"
                          >
                            Copy
                          </button>
                        </div>
                        <div className="p-2 rounded bg-slate-950 border border-slate-800 text-[11px] break-all select-all text-slate-300">
                          {simResult.signature}
                        </div>
                      </div>

                      {simResult.curlExample && (
                        <div>
                          <div className="flex justify-between items-center text-slate-500 text-[10px] mb-1">
                            <span>REPRODUCIBLE CURL COMMAND</span>
                            <button
                              onClick={() => copyToClipboard(simResult.curlExample, 'Curl command')}
                              className="text-cyan-400 hover:underline"
                            >
                              Copy Command
                            </button>
                          </div>
                          <pre className="p-3 rounded bg-slate-950 border border-slate-800 text-[11px] text-slate-300 overflow-x-auto">
                            {simResult.curlExample}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* TAB 6: TRANSACTION VERIFIER                                               */}
        {/* ========================================================================= */}
        {activeTab === 'verifier' && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h3 className="text-lg font-bold text-slate-100">Paystack Transaction Verifier</h3>
              <p className="text-xs text-slate-400">
                Directly query the official Paystack verification API with any reference to test prefix resolution and payment status.
              </p>
            </div>

            <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4">
              <form onSubmit={handleVerifyTransaction} className="flex gap-2">
                <input
                  type="text"
                  required
                  value={verifyRef}
                  onChange={e => setVerifyRef(e.target.value)}
                  placeholder="Enter reference e.g. lufak_order_123 or paystack ref"
                  className="flex-1 px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                />
                <button
                  type="submit"
                  disabled={verifying}
                  className="px-5 py-2.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl text-xs font-semibold shadow-md shadow-cyan-600/20 flex items-center gap-1.5 transition-all disabled:opacity-50"
                >
                  <ShieldCheck className={`w-4 h-4 ${verifying ? 'animate-spin' : ''}`} />
                  <span>{verifying ? 'Verifying...' : 'Verify Reference'}</span>
                </button>
              </form>

              {verifyResult && (
                <div className="pt-4 border-t border-slate-800 space-y-4 text-xs font-mono">
                  <div className="grid grid-cols-2 gap-3 p-4 rounded-xl bg-slate-950 border border-slate-800">
                    <div>
                      <span className="text-slate-500 block">Reference</span>
                      <span className="font-bold text-slate-200">{verifyResult.reference}</span>
                    </div>

                    <div>
                      <span className="text-slate-500 block">Resolved Site</span>
                      <span className="font-bold text-cyan-400">
                        {verifyResult.resolvedSite?.key ? `${verifyResult.resolvedSite.name} (${verifyResult.resolvedSite.key})` : 'Unmatched'}
                      </span>
                    </div>

                    <div>
                      <span className="text-slate-500 block">Match Type</span>
                      <span className="text-slate-300">
                        {verifyResult.resolvedSite?.matchType || 'None'}
                        {verifyResult.resolvedSite?.matchedRule && (
                          <span className="ml-1 text-cyan-400 font-mono text-[10px]">
                            ({verifyResult.resolvedSite.matchedRule})
                          </span>
                        )}
                      </span>
                    </div>

                    <div>
                      <span className="text-slate-500 block">Paystack Status</span>
                      <span className={`font-bold ${verifyResult.verification?.success ? 'text-emerald-400' : 'text-red-400'}`}>
                        {verifyResult.verification?.success ? 'VERIFIED' : 'FAILED / UNKNOWN'}
                      </span>
                    </div>

                    {verifyResult.verification?.data?.amount != null && (
                      <div className="col-span-2 pt-2 border-t border-slate-900">
                        <span className="text-slate-500 block">Amount</span>
                        <span className="font-bold text-emerald-400">
                          GH₵ {(Number(verifyResult.verification.data.amount) / 100).toFixed(2)}{' '}
                          <span className="text-slate-500 font-normal">({verifyResult.verification.data.amount} pesewas)</span>
                        </span>
                      </div>
                    )}
                  </div>

                  {(verifyResult.resolvedSite?.resolvedCallbackUrl || verifyResult.resolvedSite?.callbackUrl) && (
                    <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                      <span className="text-slate-500 block text-[10px]">TARGET CALLBACK REDIRECT</span>
                      <span className="text-slate-300 break-all font-mono">
                        {verifyResult.resolvedSite.resolvedCallbackUrl || verifyResult.resolvedSite.callbackUrl}
                      </span>
                    </div>
                  )}

                  <div>
                    <span className="text-slate-500 block mb-1 text-[10px]">PAYSTACK API RESPONSE</span>
                    <pre className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-[11px] text-slate-300 overflow-x-auto">
                      {JSON.stringify(verifyResult.verification, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-4 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>Paystack Multi-Site Proxy • Modern Next.js Interface</span>
          <span className="text-slate-600 font-mono">Real-time dynamic configuration enabled</span>
        </div>
      </footer>
    </div>
  );
}
