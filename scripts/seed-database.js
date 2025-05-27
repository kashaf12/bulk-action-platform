const { Client } = require('pg');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

// Configuration
const config = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'bulk_action_platform',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password123',
};

const BATCH_SIZE = 1000; // Increased batch size for CSV ingestion

// CSV file paths (optional - if set, data will be read from these files)
const CONTACTS_CSV_PATH = path.resolve('../seed_data/contacts.csv');

const BULK_ACTIONS_CSV_PATH = path.resolve('../seed_data/bulk-actions.csv');
const BULK_ACTION_STATS_CSV_PATH = path.resolve('../seed_data/bulk-action-stats.csv');

class DatabaseSeeder {
  constructor() {
    this.client = new Client(config);
  }

  async connect() {
    await this.client.connect();
    console.log('✅ Connected to DB');
  }

  async disconnect() {
    await this.client.end();
    console.log('✅ Disconnected from DB');
  }

  async clearExistingData() {
    console.log('🧹 Clearing ALL existing data...');
    try {
      // 1. Clear bulk_action_stats first (child table of bulk_actions)
      await this.client.query('DELETE FROM bulk_action_stats;');
      console.log('  Cleared bulk_action_stats.');

      // 2. Clear bulk_actions (parent of stats)
      await this.client.query('DELETE FROM bulk_actions;');
      console.log('  Cleared bulk_actions.');

      // 3. Clear contacts
      await this.client.query('DELETE FROM contacts;');
      console.log('  Cleared contacts.');

      console.log('✅ ALL previous data cleared successfully.');
    } catch (error) {
      console.error('❌ Error clearing data:', error.message);
      throw error; // Re-throw to stop the seeding process if cleanup fails
    }
  }

  /**
   * Helper function to read data from a CSV file.
   * @param {string} filePath - The path to the CSV file.
   * @returns {Promise<Array<Object>>} A promise that resolves with an array of parsed CSV rows.
   */
  async readCsv(filePath) {
    return new Promise((resolve, reject) => {
      const results = [];
      if (!fs.existsSync(filePath)) {
        return reject(new Error(`Input file not found: ${filePath}`));
      }
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', data => results.push(data))
        .on('end', () => resolve(results))
        .on('error', err => reject(err));
    });
  }

  // --- Contact Seeding ---

  async seedContactsFromCsv() {
    console.log(`👥 Seeding contacts from ${CONTACTS_CSV_PATH}...`);
    try {
      const contacts = await this.readCsv(CONTACTS_CSV_PATH);
      if (contacts.length === 0) {
        console.warn('⚠️ No contacts found in CSV. Skipping contact seeding.');
        return;
      }

      for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
        const batch = contacts.slice(i, i + BATCH_SIZE);
        const valuesPlaceholders = batch
          .map(
            (_, index) =>
              `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3}), $${index * 3 + 4})`
          )
          .join(', ');

        const flatParams = batch.flatMap(row => [
          row.id,
          row.name,
          row.email,
          parseInt(row.age) || null,
        ]);

        const query = `
          INSERT INTO contacts (id, name, email, age)
          VALUES ${valuesPlaceholders}
          ON CONFLICT (email) DO NOTHING;
        `;
        await this.client.query(query, flatParams);
        console.log(
          `  Processed ${Math.min(i + BATCH_SIZE, contacts.length)}/${contacts.length} contacts.`
        );
      }
      console.log(`✅ ${contacts.length} contacts seeded from CSV.`);
    } catch (error) {
      console.error(`❌ Error seeding contacts from CSV: ${error.message}`);
      throw error;
    }
  }

  // --- Bulk Action and Stats Seeding ---

  async seedBulkActionsFromCsv() {
    console.log(`⚙️  Seeding bulk actions from ${BULK_ACTIONS_CSV_PATH}...`);
    try {
      const bulkActions = await this.readCsv(BULK_ACTIONS_CSV_PATH);
      if (bulkActions.length === 0) {
        console.warn('⚠️ No bulk actions found in CSV. Skipping bulk action seeding.');
        return;
      }

      for (let i = 0; i < bulkActions.length; i += BATCH_SIZE) {
        const batch = bulkActions.slice(i, i + BATCH_SIZE);
        const valuesPlaceholders = batch
          .map((_, index) => {
            const numColumns = 13; // Number of columns in bulk_actions table
            return `(${Array.from({ length: numColumns }, (_, idx) => `$${index * numColumns + idx + 1}`).join(', ')})`;
          })
          .join(', ');

        const flatParams = batch.flatMap(row => [
          row.id,
          row.account_id,
          row.entity_type,
          row.action_type,
          row.status,
          parseInt(row.total_entities) || 0,
          row.scheduled_at ? new Date(row.scheduled_at) : null,
          row.started_at ? new Date(row.started_at) : null,
          row.completed_at ? new Date(row.completed_at) : null,
          row.configuration ? JSON.parse(row.configuration) : {},
          row.error_message || null,
          row.file_path,
          parseInt(row.file_size) || 0,
        ]);

        const query = `
          INSERT INTO bulk_actions (
            id, account_id, entity_type, action_type, status,
            total_entities, scheduled_at, started_at, completed_at,
            configuration, error_message
          ) VALUES ${valuesPlaceholders}
          ON CONFLICT (id) DO UPDATE SET
            account_id = EXCLUDED.account_id,
            entity_type = EXCLUDED.entity_type,
            action_type = EXCLUDED.action_type,
            status = EXCLUDED.status,
            total_entities = EXCLUDED.total_entities,
            scheduled_at = EXCLUDED.scheduled_at,
            started_at = EXCLUDED.started_at,
            completed_at = EXCLUDED.completed_at,
            configuration = EXCLUDED.configuration,
            error_message = EXCLUDED.error_message,
            file_path = EXCLUDED.file_path,
            file_size = EXCLUDED.file_size
        `;
        await this.client.query(query, flatParams);
        console.log(
          `  Processed ${Math.min(i + BATCH_SIZE, bulkActions.length)}/${bulkActions.length} bulk actions.`
        );
      }
      console.log(`✅ ${bulkActions.length} bulk actions seeded from CSV.`);
    } catch (error) {
      console.error(`❌ Error seeding bulk actions from CSV: ${error.message}`);
      throw error;
    }
  }

  async seedBulkActionStatsFromCsv() {
    console.log(`📊 Seeding bulk action stats from ${BULK_ACTION_STATS_CSV_PATH}...`);
    try {
      const stats = await this.readCsv(BULK_ACTION_STATS_CSV_PATH);
      if (stats.length === 0) {
        console.warn('⚠️ No bulk action stats found in CSV. Skipping stats seeding.');
        return;
      }

      for (let i = 0; i < stats.length; i += BATCH_SIZE) {
        const batch = stats.slice(i, i + BATCH_SIZE);
        const valuesPlaceholders = batch
          .map((_, index) => {
            const numColumns = 5; // action_id, total_records, successful_records, failed_records, skipped_records
            return `(${Array.from({ length: numColumns }, (_, idx) => `$${index * numColumns + idx + 1}`).join(', ')})`;
          })
          .join(', ');

        const flatParams = batch.flatMap(row => [
          row.action_id,
          parseInt(row.total_records) || 0,
          parseInt(row.successful_records) || 0,
          parseInt(row.failed_records) || 0,
          parseInt(row.skipped_records) || 0,
        ]);

        const query = `
          INSERT INTO bulk_action_stats (
            action_id, total_records, successful_records, failed_records, skipped_records
          ) VALUES ${valuesPlaceholders}
          ON CONFLICT (action_id) DO UPDATE SET
            total_records = EXCLUDED.total_records,
            successful_records = EXCLUDED.successful_records,
            failed_records = EXCLUDED.failed_records,
            skipped_records = EXCLUDED.skipped_records;
        `;
        await this.client.query(query, flatParams);
        console.log(
          `  Processed ${Math.min(i + BATCH_SIZE, stats.length)}/${stats.length} bulk action stats.`
        );
      }
      console.log(`✅ ${stats.length} bulk action stats seeded from CSV.`);
    } catch (error) {
      console.error(`❌ Error seeding bulk action stats from CSV: ${error.message}`);
      throw error;
    }
  }

  async run() {
    try {
      await this.connect();
      await this.clearExistingData();
      await this.seedContactsFromCsv();
      await this.seedBulkActionsFromCsv(); // This method now conditionally calls faker or CSV methods
    } catch (err) {
      console.error('❌ Seeding failed:', err.message);
      if (err.detail) {
        console.error('DB Error Detail:', err.detail);
      }
    } finally {
      await this.disconnect();
    }
  }
}

new DatabaseSeeder().run();
