import { Observable, throwError } from 'rxjs';
import { v4 } from 'uuid';
import { IBackendService, LoadFn, TransformPostFn, TransformPutFn, TransformGetFn, IJoinField } from '../interfaces/backend.interface';
import { BackendConfigArgs } from '../interfaces/configuration.interface';
import { IPassThruBackend } from '../interfaces/interceptor.interface';
import { IQueryParams, IQueryResult, IQueryFilter } from '../interfaces/query.interface';
import { STATUS } from '../utils/http-status-codes';
import { BackendService, clone } from './backend.service';

export class MemoryDbService extends BackendService implements IBackendService {

  private db: Map<string, Array<any>>;

  constructor(config: BackendConfigArgs) {
    super(config);
  }

  createDatabase(): Promise<boolean> {
    this.dbReadySubject.next(false);
    return new Promise<boolean>((resolve, reject) => {
      this.db = new Map<string, Array<any>>();
      resolve(true);
    });
  }

  deleteDatabase(): Promise<boolean> {
    this.dbReadySubject.next(false);
    return new Promise<boolean>((resolve, reject) => {
      this.db = undefined;
      resolve(true);
    });
  }

  createObjectStore(dataServiceFn: Map<string, LoadFn>): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      dataServiceFn.forEach((loadFn, name) => {
        this.db.set(name, []);
        if (loadFn && loadFn instanceof Function) {
          loadFn.call(null, this);
        }
      });
      this.dbReadySubject.next(true);
      resolve(true);
    });
  }

  storeData(collectionName: string, data: any): Promise<string | number> {
    return new Promise<string | number>((resolve, reject) => {
      try {
        const objectStore = this.db.get(collectionName);
        if (!data.id) {
          data['id'] = this.generateStrategyId(objectStore, collectionName);
        }
        objectStore.push(data);
        resolve(data['id']);
      } catch (error) {
        reject(error);
      }
    });
  }

  clearData(collectionName: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.db.set(collectionName, []);
      resolve(true);
    });
  }

  hasCollection(collectionName: string): boolean {
    return this.db.has(collectionName);
  }

  listCollections(): string[] {
    return Array.from( this.db.keys() );
  }

  getInstance$(collectionName: string, id: any): Observable<any> {
    return new Observable((observer) => {
      const objectStore = this.db.get(collectionName);
      if (id !== undefined && id !== '') {
        observer.next(this.findById(objectStore, id));
        observer.complete();
      } else {
        observer.error('Não foi passado o id');
      }
    });
  }

  getAllByFilter$(collectionName: string, conditions?: Array<IQueryFilter>): Observable<any> {
    const self = this;
    return new Observable((observer) => {
      const objectStore = self.db.get(collectionName);
      const queryParams: IQueryParams = { count: 0, conditions };
      const queryResults: IQueryResult = { hasNext: false, items: [] };

      const cursor = {
        index: 0,
        value: null,
        continue: (): any => {}
      };
      while (cursor.index <= objectStore.length) {
        cursor.value = (cursor.index < objectStore.length) ? clone(objectStore[cursor.index++]) : null;
        if (self.getAllItems((cursor.value ? cursor : null), queryResults, queryParams, undefined, undefined)) {
          observer.next(queryResults.items);
          observer.complete();
          break;
        }
      }
    });
  }

  get$(
    collectionName: string, id: string, query: Map<string, string[]>, url: string, caseSensitiveSearch?: string
  ): Observable<any> {
    return new Observable((observer) => {
      const objectStore = this.db.get(collectionName);

      if (id !== undefined && id !== '') {
        const joinFields = this.joinnersGetByIdMap.get(collectionName);
        const transformfn = this.transformGetByIdMap.get(collectionName);
        const findId = id ? this.config.strategyId === 'autoincrement' ? parseInt(id, 10) : id : undefined;
        let item = this.findById(objectStore, findId);

        item = item ? clone(item) : item;

        (async (itemAsync: any, getJoinFields: IJoinField[], transformGetFn: TransformGetFn) => {
          if (itemAsync && getJoinFields !== undefined) {
            await this.applyJoinFields(itemAsync, getJoinFields);
          }
          if (itemAsync && transformGetFn !== undefined) {
            itemAsync = await this.applyTransformGet(itemAsync, transformGetFn);
          }
          return this.utils.createResponseOptions(url, item ? STATUS.OK : STATUS.NOT_FOUND, this.bodify(itemAsync));
        })(item, joinFields, transformfn).then(response => {
          observer.next(response);
          observer.complete();
        });
      } else {
        let queryParams: IQueryParams = { count: 0 };
        const queryResults: IQueryResult = { hasNext: false, items: [] };
        if (query) {
          queryParams = this.getQueryParams(collectionName,
            query, (caseSensitiveSearch ? caseSensitiveSearch : 'i'));
        }
        const joinFields = this.joinnersGetAllMap.get(collectionName);
        const transformfn = this.transformGetAllMap.get(collectionName);
        const cursor = {
          index: 0,
          value: null,
          continue: (): any => {}
        };
        while (cursor.index <= objectStore.length) {
          cursor.value = (cursor.index < objectStore.length) ? clone(objectStore[cursor.index++]) : null;
          if (this.getAllItems((cursor.value ? cursor : null), queryResults, queryParams, joinFields, transformfn)) {
            const response = this.utils.createResponseOptions(url, STATUS.OK, this.pagefy(queryResults, queryParams));
            observer.next(response);
            observer.complete();
            break;
          }
        }
      }
    });
  }

  post$(collectionName: string, id: string, item: any, url: string): Observable<any> {
    return new Observable((observer) => {
      const objectStore = this.db.get(collectionName);

      if (!item.id) {
        item['id'] = this.generateStrategyId(objectStore, collectionName);
      }

      let findId = id ? this.config.strategyId === 'autoincrement' ? parseInt(id, 10) : id : undefined;
      if (findId && findId !== item.id) {
        const response = this.utils.createErrorResponseOptions(url, STATUS.BAD_REQUEST, `Request id does not match item.id`);
        observer.error(response);
        return;
      } else {
        findId = item.id;
      }

      const existingIx = this.indexOf(objectStore, findId);

      if (existingIx === -1) {
        (async () => {
          const transformfn = this.transformPostMap.get(collectionName);
          if (transformfn !== undefined) {
            item = await this.applyTransformPost(item, transformfn);
          }

          objectStore.push(item);
          const response: any = this.utils.createResponseOptions(url, STATUS.CREATED, this.bodify(clone(item)));
          return response.clone({ headers: response.headers.append('Location', url + '/' + item.id) });
        })().then(response => {
          observer.next(response);
          observer.complete();
        }, error => observer.error(error));
      } else if (this.config.post409) {
        const response = this.utils.createErrorResponseOptions(url, STATUS.CONFLICT,
          {message: `'${collectionName}' item with id='${id}' exists and may not be updated with POST.`,
          detailedMessage: 'Use PUT instead.'});
        observer.error(response);
      } else {
        (async () => {
          const transformfn = this.transformPutMap.get(collectionName);
          if (transformfn !== undefined) {
            item = await this.applyTransformPut(objectStore[existingIx], item, transformfn);
          }

          if (this.config.appendExistingPost) {
            item = Object.assign({}, objectStore[existingIx], item);
          }
          objectStore[existingIx] = item;
          return this.config.post204 ?
            this.utils.createResponseOptions(url, STATUS.NO_CONTENT ) : // successful; no content
            this.utils.createResponseOptions(url, STATUS.OK, this.bodify(clone(item))); // successful; return entity
        })().then(response => {
          observer.next(response);
          observer.complete();
        }, error => observer.error(error));
      }
    });
  }

  put$(collectionName: string, id: string, item: any, url: string): Observable<any> {
    // tslint:disable-next-line:triple-equals
    if (id == undefined) {
      return throwError(this.utils.createErrorResponseOptions(url, STATUS.NOT_FOUND, `Missing "${collectionName}" id`));
    }

    const findId = this.config.strategyId === 'autoincrement' ? parseInt(id, 10) : id;
    if (item.id && item.id !== findId) {
      return throwError(this.utils.createErrorResponseOptions(url, STATUS.BAD_REQUEST,
        {message: `Request for '${collectionName}' id does not match item.id`,
        detailedMessage: `Don't provide item.id in body or provide same id in both (url, body).`}));
    }

    return new Observable((observer) => {
      const objectStore = this.db.get(collectionName);
      const existingIx = this.indexOf(objectStore, findId);

      if (existingIx >= 0) {

        (async () => {
          const transformfn = this.transformPutMap.get(collectionName);
          if (transformfn !== undefined) {
            item = await this.applyTransformPut(objectStore[existingIx], item, transformfn);
          }

          if (this.config.appendPut) {
            item = Object.assign({}, objectStore[existingIx], item);
          }

          objectStore[existingIx] = item;
          return this.config.put204 ?
            this.utils.createResponseOptions(url, STATUS.NO_CONTENT) :
            this.utils.createResponseOptions(url, STATUS.OK, this.bodify(clone(item)));
        })().then(response => {
          observer.next(response);
          observer.complete();
        });

      } else if (this.config.put404) {
        const response = this.utils.createErrorResponseOptions(url, STATUS.NOT_FOUND,
          {message: `'${collectionName}' item with id='${id} not found and may not be created with PUT.`,
          detailedMessage: 'Use POST instead.'});
        observer.error(response);
      } else {
        if (!item.id) {
          item['id'] = findId;
        }

        (async () => {
          const transformfn = this.transformPostMap.get(collectionName);
          if (transformfn !== undefined) {
            item = await this.applyTransformPost(item, transformfn);
          }

          objectStore.push(item);
          const response: any = this.utils.createResponseOptions(url, STATUS.CREATED, this.bodify(clone(item)));
          return response.clone({ headers: response.headers.append('Location', url + '/' + item.id) });
        })().then(response => {
          observer.next(response);
          observer.complete();
        });
      }
    });
  }

  delete$(collectionName: string, id: string, url: string): Observable<any> {
    // tslint:disable-next-line:triple-equals
    if (id == undefined) {
      return throwError(this.utils.createErrorResponseOptions(url, STATUS.NOT_FOUND, `Missing "${collectionName}" id`));
    }
    return new Observable((observer) => {
      const objectStore = this.db.get(collectionName);
      const findId = this.config.strategyId === 'autoincrement' ? parseInt(id, 10) : id;
      if (this.removeById(objectStore, findId) || !this.config.delete404) {
        const response = this.utils.createResponseOptions(url, STATUS.NO_CONTENT);
        observer.next(response);
        observer.complete();
      } else {
        const response = this.utils.createErrorResponseOptions(url, STATUS.NOT_FOUND,
          {message: `Error to find '${collectionName}' with id='${id}'`, detailedMessage: 'Id não encontrado.'});
        observer.error(response);
      }
    });
  }

  private generateStrategyId<T extends { id: any }>(collection: T[], collectionName: string): string | number {
    if (this.config.strategyId === 'provided') {
      throw new Error('Id strategy is set as `provided` and id not provided.');
    }
    if (this.config.strategyId === 'uuid') {
      return v4();
    } else {
      if (!this.isCollectionIdNumeric(collection)) {
        throw new Error(
          `Collection '${collectionName}' id type is non-numeric or unknown. Can only generate numeric ids.`);
      }
      let maxId = 0;
      collection.reduce((prev: any, item: any) => {
        maxId = Math.max(maxId, typeof item.id === 'number' ? item.id : maxId);
      }, undefined);
      return maxId + 1;
    }
  }

  private isCollectionIdNumeric<T extends { id: any }>(collection: T[]): boolean {
    // so that it could know the type of the `id` even when the collection is empty.
    return !!(collection && collection[0]) && typeof collection[0].id === 'number';
  }

  private findById<T extends { id: any }>(collection: T[], id: any): T {
    return collection.find((item: T) => item.id === id);
  }

  private indexOf(collection: any[], id: any) {
    return collection.findIndex((item: any) => item.id === id);
  }

  private removeById(collection: any[], id: any) {
    const ix = this.indexOf(collection, id);
    if (ix > -1) {
      collection.splice(ix, 1);
      return true;
    }
    return false;
  }

  createPassThruBackend(): IPassThruBackend {
    throw new Error('Method not implemented.');
  }
}
