const { faker } = require('@faker-js/faker');
const { createObjectCsvWriter } = require('csv-writer');
const path = require('path');
const fs = require('fs');

// --- Configuration ---
const SEED_CONTACTS_COUNT = 10000;
const SEED_BULK_ACTIONS_COUNT = 50;

// Output directory for CSV files
const OUTPUT_DIR = path.resolve('./seed_data');

// Output file paths
const CONTACTS_CSV_FILE = path.join(OUTPUT_DIR, 'contacts.csv');
const BULK_ACTIONS_CSV_FILE = path.join(OUTPUT_DIR, 'bulk-actions.csv');
const BULK_ACTION_STATS_CSV_FILE = path.join(OUTPUT_DIR, 'bulk-action-stats.csv');

// Ensure the output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`Created output directory: ${OUTPUT_DIR}`);
}

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

const BULK_ACTION_STATUSES = [
  'completed',
  'failed',
  'processing',
  'queued',
  'cancelled',
  'scheduled',
  'validating',
];

// --- Data Generation Functions ---

async function generateContactsData() {
  console.log(`Generating ${SEED_CONTACTS_COUNT} contacts...`);
  const contactsData = [];
  for (let i = 0; i < SEED_CONTACTS_COUNT; i++) {
    // Use a deterministic email format for consistent contact identification
    const deterministicEmail = `contact${i}@example.com`;
    contactsData.push({
      id: faker.string.uuid(),
      name: faker.person.fullName(),
      email: deterministicEmail,
      age: faker.number.int({ min: 18, max: 80 }),
      version: 1,
    });
  }
  console.log('✅ Contacts data generated.');
  return contactsData;
}

async function generateBulkActionsAndStatsData() {
  console.log(`Generating ${SEED_BULK_ACTIONS_COUNT} bulk actions and stats...`);
  const bulkActionsData = [];
  const bulkActionStatsData = [];

  for (let i = 0; i < SEED_BULK_ACTIONS_COUNT; i++) {
    // Generate deterministic UUID for actionId using faker's seeded UUID
    const actionId = faker.string.uuid();
    const accountId = faker.helpers.arrayElement(TEST_ACCOUNTS);
    const status = faker.helpers.arrayElement(BULK_ACTION_STATUSES);
    const totalEntities = faker.number.int({ min: 100, max: 5000 });
    let startedAt = null;
    let completedAt = null;
    let errorMessage = null;
    let scheduledAt = null;
    let processedEntities = 0;

    switch (status) {
      case 'completed':
        processedEntities = totalEntities;
        startedAt = faker.date.recent({ days: 7 }).toISOString();
        completedAt = new Date(
          new Date(startedAt).getTime() + faker.number.int({ min: 30000, max: 600000 })
        ).toISOString();
        break;
      case 'failed':
        processedEntities = faker.number.int({ min: 0, max: totalEntities - 1 });
        startedAt = faker.date.recent({ days: 5 }).toISOString();
        completedAt = new Date(
          new Date(startedAt).getTime() + faker.number.int({ min: 10000, max: 180000 })
        ).toISOString();
        errorMessage = faker.lorem.sentence();
        break;
      case 'processing':
        processedEntities = faker.number.int({ min: 0, max: totalEntities });
        startedAt = faker.date.recent({ days: 2 }).toISOString();
        break;
      case 'cancelled':
        processedEntities = faker.number.int({ min: 0, max: totalEntities / 2 });
        startedAt = faker.date.recent({ days: 3 }).toISOString();
        completedAt = new Date(
          new Date(startedAt).getTime() + faker.number.int({ min: 5000, max: 120000 })
        ).toISOString();
        break;
      case 'queued':
        scheduledAt = faker.date.future({ years: 0.1 }).toISOString();
        break;
      case 'scheduled':
        scheduledAt = faker.date.future({ years: 0.1 }).toISOString();
        break;
      case 'validating':
        startedAt = faker.date.recent({ days: 1 }).toISOString();
        break;
      default:
        break;
    }

    const configuration = {
      deduplication: faker.datatype.boolean(),
    };

    const filePath = `/uploads/${accountId}/${actionId}.csv`;

    bulkActionsData.push({
      id: actionId,
      account_id: accountId,
      entity_type: 'contact',
      action_type: 'bulk_update',
      status: status,
      total_entities: totalEntities,
      scheduled_at: scheduledAt,
      started_at: startedAt,
      completed_at: completedAt,
      configuration: JSON.stringify(configuration), // Store as JSON string
      error_message: errorMessage,
      file_path: filePath,
      file_size: faker.number.int({ min: 1000, max: 1e6 }),
      batch_size: faker.helpers.arrayElement([500, 1000, 2000]),
      retry_count: status === 'failed' ? faker.number.int({ min: 1, max: 3 }) : 0,
      max_retries: 3,
      priority: faker.number.int({ min: 1, max: 10 }),
    });

    // Generate stats data for the same actionId
    let successfulRecords = 0;
    let failedRecords = 0;
    let skippedRecords = 0;

    if (status === 'completed') {
      successfulRecords = totalEntities;
    } else if (status === 'failed') {
      successfulRecords = processedEntities;
      failedRecords = totalEntities - processedEntities;
      skippedRecords = faker.number.int({ min: 0, max: Math.floor(failedRecords / 2) });
    } else if (status === 'cancelled') {
      successfulRecords = processedEntities;
      skippedRecords = totalEntities - processedEntities;
    } else if (status === 'processing' || status === 'validating') {
      successfulRecords = processedEntities;
      failedRecords = faker.number.int({ min: 0, max: Math.floor(totalEntities / 5) });
      skippedRecords = faker.number.int({ min: 0, max: Math.floor(totalEntities / 10) });
    } else {
      successfulRecords = 0;
      failedRecords = 0;
      skippedRecords = 0;
    }

    bulkActionStatsData.push({
      action_id: actionId,
      total_records: totalEntities,
      successful_records: successfulRecords,
      failed_records: failedRecords,
      skipped_records: skippedRecords,
    });
  }
  console.log('✅ Bulk actions and stats data generated.');
  return { bulkActionsData, bulkActionStatsData };
}

// --- Main Execution ---

async function generateAndWriteCsvs() {
  try {
    // Generate data
    const contacts = await generateContactsData();
    const { bulkActionsData, bulkActionStatsData } = await generateBulkActionsAndStatsData();

    // Define CSV Headers
    const contactsHeaders = [
      { id: 'id', title: 'id' },
      { id: 'name', title: 'name' },
      { id: 'email', title: 'email' },
      { id: 'age', title: 'age' },
    ];

    const bulkActionsHeaders = [
      { id: 'id', title: 'id' },
      { id: 'account_id', title: 'account_id' },
      { id: 'entity_type', title: 'entity_type' },
      { id: 'action_type', title: 'action_type' },
      { id: 'status', title: 'status' },
      { id: 'total_entities', title: 'total_entities' },
      { id: 'scheduled_at', title: 'scheduled_at' },
      { id: 'started_at', title: 'started_at' },
      { id: 'completed_at', title: 'completed_at' },
      { id: 'configuration', title: 'configuration' },
      { id: 'error_message', title: 'error_message' },
      { id: 'file_path', title: 'file_path' },
      { id: 'file_size', title: 'file_size' },
      { id: 'batch_size', title: 'batch_size' },
      { id: 'retry_count', title: 'retry_count' },
      { id: 'max_retries', title: 'max_retries' },
      { id: 'priority', title: 'priority' },
    ];

    const bulkActionStatsHeaders = [
      { id: 'action_id', title: 'action_id' },
      { id: 'total_records', title: 'total_records' },
      { id: 'successful_records', title: 'successful_records' },
      { id: 'failed_records', title: 'failed_records' },
      { id: 'skipped_records', title: 'skipped_records' },
    ];

    // Create CSV Writers
    const contactsCsvWriter = createObjectCsvWriter({
      path: CONTACTS_CSV_FILE,
      header: contactsHeaders,
    });

    const bulkActionsCsvWriter = createObjectCsvWriter({
      path: BULK_ACTIONS_CSV_FILE,
      header: bulkActionsHeaders,
    });

    const bulkActionStatsCsvWriter = createObjectCsvWriter({
      path: BULK_ACTION_STATS_CSV_FILE,
      header: bulkActionStatsHeaders,
    });

    // Write data to CSV files
    await contactsCsvWriter.writeRecords(contacts);
    console.log(`✅ Contacts CSV written to ${CONTACTS_CSV_FILE}`);

    await bulkActionsCsvWriter.writeRecords(bulkActionsData);
    console.log(`✅ Bulk Actions CSV written to ${BULK_ACTIONS_CSV_FILE}`);

    await bulkActionStatsCsvWriter.writeRecords(bulkActionStatsData);
    console.log(`✅ Bulk Action Stats CSV written to ${BULK_ACTION_STATS_CSV_FILE}`);

    console.log('\n✨ All seed data CSVs generated successfully! ✨');
  } catch (error) {
    console.error('❌ Error generating seed data CSVs:', error);
    process.exit(1);
  }
}

// Run the main function
generateAndWriteCsvs();
