import fs from 'fs';
import csv from 'csv-parser';
import { createObjectCsvWriter } from 'csv-writer';

const inputFile = 'scripts/csv/data-1000000.csv';
const outputFile = 'scripts/csv/updated-data-1000000.csv';

// Generate random alphanumeric string
const randomString = (length = 10) =>
  Math.random()
    .toString(36)
    .substring(2, 2 + length);

// Read CSV, modify names, write new CSV
const rows = [];

fs.createReadStream(inputFile)
  .pipe(csv())
  .on('data', row => {
    row.name = randomString(); // Replace 'name' with random string
    rows.push(row);
  })
  .on('end', () => {
    const headers = Object.keys(rows[0]).map(key => ({ id: key, title: key }));
    const writer = createObjectCsvWriter({ path: outputFile, header: headers });

    writer
      .writeRecords(rows)
      .then(() => console.log(`✅ CSV written to ${outputFile}`))
      .catch(console.error);
  });
