import { EntityType } from '../types/entities/bulk-action';
import { EntityStrategy } from '../interfaces/EntityStrategy';
import { ContactStrategy } from '../strategies/ContactStrategy';

export class EntityRegistry {
  private static strategies = new Map<EntityType, EntityStrategy<any>>();

  static {
    // Compile-time registration
    this.strategies.set('contact', new ContactStrategy());
    // this.strategies.set('company', new CompanyStrategy()); // Future
    // this.strategies.set('lead', new LeadStrategy());       // Future
  }

  static getStrategy<T>(entityType: EntityType): EntityStrategy<T> {
    const strategy = this.strategies.get(entityType);
    if (!strategy) {
      throw new Error(`No strategy registered for entity type: ${entityType}`);
    }
    return strategy;
  }

  static getSupportedEntities(): EntityType[] {
    return Array.from(this.strategies.keys());
  }
}
