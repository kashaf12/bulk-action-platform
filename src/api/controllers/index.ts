import { BulkActionController } from './BulkActionController';
import { BulkActionStatController } from './BulkActionStatController';
import { HealthController } from './HealthController';
import { BulkActionService } from '../../services/BulkActionService';
import { BulkActionStatService } from '../../services/BulkActionStatService';
import { BulkActionRepository } from '../../repositories/BulkActionRepository';
import { BulkActionStatRepository } from '../../repositories/BulkActionStatRepository';

// Initialize repositories
const bulkActionRepository = new BulkActionRepository();
const bulkActionStatRepository = new BulkActionStatRepository();

// Initialize services
const bulkActionService = new BulkActionService(bulkActionRepository);
const bulkActionStatService = new BulkActionStatService(bulkActionStatRepository);

// Initialize controllers with dependency injection
const bulkActionController = new BulkActionController(bulkActionService, bulkActionStatService);
const bulkActionStatController = new BulkActionStatController(bulkActionStatService);
const healthController = new HealthController();

export { bulkActionController, bulkActionStatController, healthController };
