-- =====================================================
-- Performance Indexes for Bulk Action Platform
-- =====================================================

-- =====================================================
-- CONTACTS TABLE INDEXES
-- =====================================================

-- Primary lookup indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_email ON contacts(email);

-- =====================================================
-- BULK ACTIONS TABLE INDEXES
-- =====================================================

-- Primary lookup indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bulk_actions_id ON bulk_actions(id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bulk_actions_account_id ON bulk_actions(account_id);

-- =====================================================
-- BULK ACTION STATS TABLE INDEXES
-- =====================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bulk_action_stats_action_id ON bulk_action_stats(action_id);

-- =====================================================
-- ANALYZE TABLES FOR OPTIMIZER
-- =====================================================

ANALYZE contacts;
ANALYZE bulk_actions;
ANALYZE bulk_action_stats;
