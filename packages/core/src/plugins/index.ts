/**
 * Plugin subsystem: the frozen v1 author-facing API plus the same-process loader.
 * Plugins are trusted, in-process code — the loader isolates failures, not privileges.
 */
export * from './api.js';
export * from './loader.js';
