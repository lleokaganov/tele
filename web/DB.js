/* log console */
const DB = {

    last_db: null, // Храним последнюю открытую базу

    toHuman: function(x,p=2) { var i=0; for(;x>=1024;x/=1024,i++){} return Math.round(x,p)+['b','Kb','Mb','Gb','Tb','Pb'][i]; },
/*
	var l=1024*1024*1024, m=10;
	if(x > l/2) return Math.round(m*(x/l))/m+"Gb";
	l=1024*1024; if(x > l/2) return Math.round(m*(x/l))/m+"Mb";
	l=1024; if(x > l/2) return Math.round(m*(x/l))/m+"Kb";
	return x+"Kb";
    },
*/

    free: async function() {
	if('storage' in navigator && 'estimate' in navigator.storage) {
	    const r = await navigator.storage.estimate();
	    r.Usage = DB.toHuman(r.usage);
	    r.Quota = DB.toHuman(r.quota);
	    r.percent = (( r.usage / r.quota) * 100).toFixed(2);
	    r.s = `DB used ${r.percent}% : ${r.usage} (${r.Usage}) / ${r.quota} (${r.Quota})`;
	    return r; // dom('buki',`Использовано: ${r.usage} Лимит: ${r.quota} байт`);
	} return {}; // dom('buki','StorageManager API не поддерживается.');
    },

    // ✅ Открыть соединение
    open: function(db, ver, onupgradeFn) {
	if(DB.last_db && DB.last_db.name === db && (!ver || DB.last_db.version === ver)) return Promise.resolve(DB.last_db);
    	DB.close(); // Закрываем старую базу перед открытием новой
	return new Promise((resolve, reject) => {
    	    const request = indexedDB.open(db, ver);
	    if(onupgradeFn) request.onupgradeneeded = (event) => onupgradeFn(event.target.result);
            request.onsuccess = event => resolve( DB.last_db = event.target.result );
            request.onerror = event => reject(event.target.error);
	});
    },

    // ✅ Закрыть открытое соединение
    close: function() {
        if(DB.last_db) { DB.last_db.close(); DB.last_db = null; }
    },

    // ✅ Получение списка всех баз
    db: async function() {
	return indexedDB.databases ? (await indexedDB.databases()).map(d => d.name).filter(Boolean) : [];
    },

    // ✅ Получение списка всех таблиц в базе db
    tables: async function(db = 'maindb') {
        return Array.from( ( await DB.open(db) ).objectStoreNames);
    },

    // ✅ Создание новой базы
    add_db: async function(db = 'maindb') {
	return (await DB.getVersion(db)) ? false : DB.open(db, 1);
    },

    // ✅ Удаление базы
    del_db: async function(db = 'maindb') {
	if(!await DB.getVersion(db)) return true;
	DB.close(); // Гарантируем, что соединение закрыто
	return new Promise((resolve, reject) => {
    	    const request = indexedDB.deleteDatabase(db);
    	    request.onsuccess = () => resolve(true);
    	    request.onerror = event => reject(event.target.error);
    	    request.onblocked = () => console.warn(`⚠ ️Can't delete ${db} - database is in use.`);
	});
    },

    // ✅ Получение текущей версии базы
    getVersion: async function(db) {
	return (await indexedDB.databases()).find(d => d.name === db)?.version || 0;
    },

    // ✅ Существует ли база db
    db_exist: async function(db) {
	return await DB.getVersion(db);
    },

    // ✅ Существует ли таблица table в базе db
    table_exist: async function(db, table) {
	return (await DB.db_exist(db)) && (await DB.tables(db)).includes(table) ;
    },

    // ✅ Создание таблицы
    add_table: async function(db = 'maindb', table = 'table', key = "id") {
	const ver = await DB.getVersion(db)
	if(!(ver)) throw new Error(`DB ${dbName} not exist`);
	const d = await DB.open(db, ver);
	if(d.objectStoreNames.contains(table)) return d;
	DB.close(); // Закрываем соединение перед изменением схемы
        return DB.open(db,ver+1,(d) => {
    	    if(!d.objectStoreNames.contains(table)) d.createObjectStore(table, { keyPath: key });
	});
    },

    // ✅ Удаление таблицы
    del_table: async function(db = 'maindb', table) {
	const ver = await DB.getVersion(db);
	if(!(ver)) throw new Error(`DB ${dbName} not exist`);
	const d = await DB.open(db, ver);
	if(!d.objectStoreNames.contains(table)) return true;
	DB.close(); // Закрываем перед изменением схемы
        return DB.open(db,ver+1,(d) => {
    	    if(d.objectStoreNames.contains(table)) d.deleteObjectStore(table);
	});
    },

    // ✅ Добавление данных в таблицу
    add: async function(db, table, data, mode='replace') {
	const tx = (await DB.open(db)).transaction(table, "readwrite");
	if(mode==='replace') tx.objectStore(table).put(data); // .put перезапишет, если key
	else tx.objectStore(table).add(data); // кинет ошибку если key есть
	return new Promise((resolve, reject) => {
    	    tx.oncomplete = () => resolve(true);
    	    tx.onerror = e => reject(e.target.error);
	});
    },

    // ✅ Чтение данных из таблицы (функция или ключ)
    get: async function(db, table, where) {
        const tx = ( await DB.open(db) ).transaction(table,"readonly");
	const store = tx.objectStore(table);
	return new Promise((resolve, reject) => {
    	    tx.onerror = e => reject(e.target.error);
    	    if(typeof where === "function") { // Если where - функция
        	const r = [];
        	store.openCursor().onsuccess = e => {
            	    const cursor = e.target.result;
            	    if(!cursor) return;
            	    if(where(cursor.value)) r.push(cursor.value);
            	    cursor.continue();
        	};
        	tx.oncomplete = () => resolve(r); // Когда транзакция закончится
        	return;
    	    }
    	    const req = where === undefined ? store.getAll() : store.get(where); // иначе это ключ
    	    req.onsuccess = () => resolve(req.result);
	});
    },

    // ✅ Полная очистка таблицы
    truncate: async function(db, table) {
        const tx = ( await DB.open(db) ).transaction(table, "readwrite");
        tx.objectStore(table).clear();
	return new Promise((resolve, reject) => {
    	    tx.oncomplete = () => resolve(true);
    	    tx.onerror = event => reject(event.target.error);
	});
    },

    // ✅ Удаление данных из таблицы (функция или ключ)
    del: async function(db, table, where) {
        const tx = (await DB.open(db)).transaction(table, "readwrite");
	const store = tx.objectStore(table);
        return new Promise((resolve, reject) => {
	    tx.oncomplete = () => resolve(true);
            tx.onerror = (e) => reject(e.target.error);
	    if(typeof where === "function") { // Если `where` — функция
    	        const req = store.openCursor();
        	req.onsuccess = (event) => {
            	    const cursor = event.target.result;
            	    if(!cursor) return; // cursor закончен, транзакция завершится
            	    if(where(cursor.value)) cursor.delete(); // Удаляем запись
            	    cursor.continue();
        	};
    	    } else store.delete(where); // Иначе `where` — это ключ
	});
    },

};
