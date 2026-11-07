/* SAMPLE DATA FOR DEMO MODE ONLY.
   Loaded on demand when someone presses "Try demo mode" (a button that is hidden on the real site). It is never loaded
   for a real login, never synced, and is safe to delete — the app works without it. Names below are invented. */
/* ------------------------------ seed data ----------------------------- */
/* Box types (used by Supplier deliveries) are a short, user-owned list — like
   Suppliers — not a fixed set of categories. Seeded with a reasonable starting
   point so the picker isn't empty on day one, but every name here is just a
   normal editable/deletable record from here on. */
async function seedDemoBoxTypes(){
  const existing = await getAll('boxTypes');
  if(existing.length) return;
  const defaults = ['Meat boxes','Fish boxes','Pork boxes','Chicken boxes','Vegetable boxes','Ice boxes','Carton boxes'];
  for(const name of defaults) await put('boxTypes', {id:uid(), name});
}

async function seedDemoWarehouses(){
  const wh = await getAll('warehouses');
  if(wh.length) return;
  const W = (name,priority)=>({id:uid(),name,description:'',priority});
  const warehouses = [W('Main Store',1), W('Dry Store',2), W('Freezer',3), W('Vegetable Store',4)];
  for(const w of warehouses) await put('warehouses', w);

  const S = (whId,name,priority)=>({id:uid(),warehouseId:whId,name,priority});
  const sections = [
    S(warehouses[0].id,'Sauces & Broths',1),
    S(warehouses[0].id,'Canned Food',2),
    S(warehouses[0].id,'Oil',3),
    S(warehouses[1].id,'Rice & Grains',1),
    S(warehouses[1].id,'Pasta',2),
    S(warehouses[1].id,'Spices',3),
    S(warehouses[2].id,'Meat',1),
    S(warehouses[2].id,'Poultry',2),
    S(warehouses[3].id,'Fresh Vegetables',1),
  ];
  for(const s of sections) await put('sections', s);

  const P = (name,unit,supplier,whId,secId,priority,exp)=>({
    id:uid(), name, unit, supplier, warehouseId:whId, sectionId:secId, priority,
    active:true, notes:'', productionDate:'', expiryDate:exp||'', image:''
  });
  const sauces = sections[0].id, canned = sections[1].id, oil = sections[2].id;
  const rice = sections[3].id, pasta = sections[4].id;
  const meat = sections[6].id, poultry = sections[7].id, veg = sections[8].id;
  const products = [
    P('Chicken Broth','Kg','ABC Food Supplier',warehouses[0].id,sauces,1,'2027-09-01'),
    P('BBQ Sauce','LTR','ABC Food Supplier',warehouses[0].id,sauces,2,'2027-04-01'),
    P('Ketchup','LTR','Delta Provisions',warehouses[0].id,sauces,3,'2027-06-01'),
    P('Tomato Peeled','Tin 400 gm','Delta Provisions',warehouses[0].id,canned,1,'2028-01-01'),
    P('Sweet Corn','Tin 400 gm','Delta Provisions',warehouses[0].id,canned,2,'2028-01-01'),
    P('Olive Oil','LTR','Aegean Traders',warehouses[0].id,oil,1,'2027-12-01'),
    P('Basmati Rice','Kg','Delta Provisions',warehouses[1].id,rice,1,''),
    P('Penne Pasta','Kg','Delta Provisions',warehouses[1].id,pasta,1,''),
    P('Beef Tenderloin','Kg','Northsea Meats',warehouses[2].id,meat,1,'2027-03-01'),
    P('Chicken Breast','Kg','Northsea Meats',warehouses[2].id,poultry,1,'2027-02-01'),
    P('Onion','Kg','Green Field Farms',warehouses[3].id,veg,1,''),
    P('Tomato Fresh','Kg','Green Field Farms',warehouses[3].id,veg,2,''),
  ];
  for(const p of products) await put('products', p);
}


async function seedDemoData(){ await seedDemoWarehouses(); await seedDemoBoxTypes(); }
