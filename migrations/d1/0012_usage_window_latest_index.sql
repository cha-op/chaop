CREATE INDEX idx_usage_windows_type_end ON usage_windows(window_type, window_end DESC, updated_at DESC, id DESC);
