// seed.js
const { faker } = require('@faker-js/faker');
const { Client } = require('pg');
const { v4: uuidv4 } = require('uuid');

// Configuration
const config = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'bulk_action_platform',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password123',
};

const SEED_CONTACTS = parseInt(process.env.SEED_CONTACTS) || 1000;
const SEED_BULK_ACTIONS = parseInt(process.env.SEED_BULK_ACTIONS) || 50; // New environment variable for bulk actions
const BATCH_SIZE = 100;

const TEST_ACCOUNTS = [
  'test-account-1',
  'test-account-2',
  'test-account-3',
  'load-test-account',
  'demo-account',
  'performance-test-1',
  'performance-test-2',
  'rate-limit-test-1',
  'rate-limit-test-2',
  'integration-test',
];

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
    // Clear bulk_action_stats first due to foreign key constraint
    await this.client.query(
      'DELETE FROM bulk_action_stats WHERE action_id IN (SELECT id FROM bulk_actions WHERE account_id LIKE $1)',
      ['%test%']
    );
    await this.client.query('DELETE FROM bulk_actions WHERE account_id LIKE $1', ['%test%']);
    // You might want to be more selective with contact deletion if not all are 'test' contacts
    // For now, let's assume we clean up all contacts seeded by this script if running frequently for tests.
    // A more robust solution might involve tagging seeded contacts or clearing only if a flag is set.
    // For simplicity, let's clear all contacts if the goal is a fresh seed every time.
    await this.client.query('DELETE FROM contacts'); // Adjust this if you have non-seed contacts you want to preserve
    console.log('🧹 Cleared previous test data');
  }

  async seedContacts() {
    console.log(`👥 Seeding ${SEED_CONTACTS} contacts...`);

    for (let i = 0; i < SEED_CONTACTS; i += BATCH_SIZE) {
      const contacts = [];

      for (let j = 0; j < Math.min(BATCH_SIZE, SEED_CONTACTS - i); j++) {
        contacts.push([
          faker.person.fullName(),
          faker.internet.email().toLowerCase(),
          faker.number.int({ min: 18, max: 80 }),
        ]);
      }

      // Generate the VALUES clause dynamically for batch insert
      const valuesPlaceholders = contacts
        .map((_, index) => `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`)
        .join(', ');
      const flatParams = contacts.flat();

      const query = `
        INSERT INTO contacts (name, email, age)
        VALUES ${valuesPlaceholders}
        ON CONFLICT (email) DO NOTHING
      `;

      await this.client.query(query, flatParams);
    }

    console.log(`✅ Contacts seeded`);
  }

  async seedBulkActions() {
    console.log('⚙️  Seeding bulk actions and stats...');

    // Updated statuses to include 'scheduled' and 'validating' as per schema
    const statuses = [
      'completed',
      'failed',
      'processing',
      'queued',
      'cancelled',
      'scheduled',
      'validating',
    ];

    for (let i = 0; i < SEED_BULK_ACTIONS; i++) {
      const accountId = faker.helpers.arrayElement(TEST_ACCOUNTS);
      const status = faker.helpers.arrayElement(statuses);
      const actionId = uuidv4();
      const totalEntities = faker.number.int({ min: 100, max: 5000 });
      let startedAt = null;
      let completedAt = null;
      let errorMessage = null;
      let scheduledAt = null;
      let processedEntities = 0; // Initialize processedEntities

      switch (status) {
        case 'completed':
          processedEntities = totalEntities;
          startedAt = faker.date.recent({ days: 7 });
          completedAt = new Date(
            startedAt.getTime() + faker.number.int({ min: 30000, max: 600000 })
          );
          break;
        case 'failed':
          // Processed entities could be anything from 0 to totalEntities - 1
          processedEntities = faker.number.int({ min: 0, max: totalEntities - 1 });
          startedAt = faker.date.recent({ days: 5 });
          completedAt = new Date(
            startedAt.getTime() + faker.number.int({ min: 10000, max: 180000 })
          );
          errorMessage = faker.lorem.sentence();
          break;
        case 'processing':
          processedEntities = faker.number.int({ min: 0, max: totalEntities });
          startedAt = faker.date.recent({ days: 2 });
          break;
        case 'cancelled':
          processedEntities = faker.number.int({ min: 0, max: totalEntities / 2 });
          startedAt = faker.date.recent({ days: 3 });
          completedAt = new Date(
            startedAt.getTime() + faker.number.int({ min: 5000, max: 120000 })
          );
          break;
        case 'queued':
          scheduledAt = faker.date.future({ years: 0.1 }); // Queued might have a future scheduled_at
          break;
        case 'scheduled':
          scheduledAt = faker.date.future({ years: 0.1 }); // Explicitly scheduled in the future
          break;
        case 'validating':
          startedAt = faker.date.recent({ days: 1 }); // Validation typically starts soon after creation/queueing
          // processedEntities might be 0 or a small number during validation
          break;
        default:
          break;
      }

      const configuration = {
        deduplication: faker.datatype.boolean(),
      };

      const filePath = `/uploads/${accountId}/${actionId}.csv`;

      const actionInsert = `
        INSERT INTO bulk_actions (
          id, account_id, entity_type, action_type, status,
          total_entities, scheduled_at, started_at, completed_at,
          configuration, error_message, file_path, file_size,
          batch_size, retry_count, max_retries, priority
        ) VALUES (
          $1, $2, 'contact', 'bulk_update', $3,
          $4, $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14, $15
        )
      `;

      // Parameters for bulk_actions insert
      const bulkActionParams = [
        actionId,
        accountId,
        status,
        totalEntities,
        scheduledAt,
        startedAt,
        completedAt,
        JSON.stringify(configuration), // configuration is JSONB
        errorMessage,
        filePath,
        faker.number.int({ min: 1000, max: 1e6 }), // file_size BIGINT
        faker.helpers.arrayElement([500, 1000, 2000]), // batch_size
        status === 'failed' ? faker.number.int({ min: 1, max: 3 }) : 0, // retry_count (only if failed)
        3, // max_retries
        faker.number.int({ min: 1, max: 10 }), // priority
      ];

      await this.client.query(actionInsert, bulkActionParams);

      // Seed bulk_action_stats
      const statsInsert = `
        INSERT INTO bulk_action_stats (
          action_id, total_records, successful_records, failed_records, skipped_records
          -- The schema for bulk_action_stats doesn't include:
          -- validation_errors, database_errors, business_logic_errors, system_errors
          -- Remove these from the insert statement and parameters if they don't exist.
          -- If you intended to add them, you'll need to update your 01-create-table.sql
        ) VALUES (
          $1, $2, $3, $4, $5
        )
      `;

      // Generate realistic stats based on action status
      let successfulRecords = 0;
      let failedRecords = 0;
      let skippedRecords = 0;

      if (status === 'completed') {
        successfulRecords = totalEntities;
      } else if (status === 'failed') {
        successfulRecords = processedEntities; // Records processed before failure
        failedRecords = totalEntities - processedEntities;
        skippedRecords = faker.number.int({ min: 0, max: Math.floor(failedRecords / 2) });
      } else if (status === 'cancelled') {
        successfulRecords = processedEntities;
        skippedRecords = totalEntities - processedEntities;
      } else if (status === 'processing' || status === 'validating') {
        successfulRecords = processedEntities; // Can be 0 for new processing/validation
        failedRecords = faker.number.int({ min: 0, max: Math.floor(totalEntities / 5) });
        skippedRecords = faker.number.int({ min: 0, max: Math.floor(totalEntities / 10) });
      } else {
        // queued, scheduled
        successfulRecords = 0;
        failedRecords = 0;
        skippedRecords = 0;
      }

      // Parameters for bulk_action_stats insert
      const statsParams = [
        actionId,
        totalEntities,
        successfulRecords,
        failedRecords,
        skippedRecords,
      ];

      await this.client.query(statsInsert, statsParams);
    }

    console.log('✅ Bulk actions + stats seeded');
  }

  async run() {
    try {
      await this.connect();
      await this.clearExistingData();
      await this.seedContacts();
      await this.seedBulkActions();
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
