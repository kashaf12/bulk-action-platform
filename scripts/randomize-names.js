import fs from 'fs';
import csv from 'csv-parser';
import { createObjectCsvWriter } from 'csv-writer';
import path from 'path';
console.log('Current script path:', process.cwd());

const inputFile = path.resolve('./seed_data/contact-100000.csv');
const outputFile = path.resolve('./seed_data/updated-contact-100000.csv');

const max_rows = 100_000;

// Generate random alphanumeric string
const randomString = (length = 10) =>
  Math.random()
    .toString(36)
    .substring(2, 2 + length);

// Read CSV, modify names, write new CSV
const rows = [];

if (!fs.existsSync(inputFile)) {
  console.error(`❌ Input file not found: ${inputFile}`);
  process.exit(1);
}

const readStream = fs
  .createReadStream(inputFile)
  .pipe(csv())
  .on('data', row => {
    row.name = randomString(); // Replace 'name' with random string
    rows.push(row);
    if (rows.length === max_rows) {
      readStream.destroy();
      const headers = Object.keys(rows[0]).map(key => ({ id: key, title: key }));
      const writer = createObjectCsvWriter({ path: outputFile, header: headers });

      writer
        .writeRecords(rows)
        .then(() => console.log(`✅ CSV written to ${outputFile}`))
        .catch(console.error);
    }
  })
  .on('end', () => {
    if (rows.length === 0) {
      console.error('❌ No data found in CSV.');
      process.exit(1);
    }
    const headers = Object.keys(rows[0]).map(key => ({ id: key, title: key }));
    const writer = createObjectCsvWriter({ path: outputFile, header: headers });

    writer
      .writeRecords(rows)
      .then(() => console.log(`✅ CSV written to ${outputFile}`))
      .catch(console.error);
  });
