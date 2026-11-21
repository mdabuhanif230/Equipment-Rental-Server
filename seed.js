import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

/** Idempotent demo seed: featured equipment + homepage reviews for a fresh database. */
const dbName = process.env.DB_NAME || 'rentgear';
const uri = process.env.MONGODB_URI || (() => {
  const { DB_USER, DB_PASSWORD, DB_CLUSTER } = process.env;
  if (DB_USER && DB_PASSWORD && DB_CLUSTER) {
    return `mongodb+srv://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${DB_CLUSTER}/${dbName}?retryWrites=true&w=majority`;
  }
  return 'mongodb://127.0.0.1:27017';
})();

const owner = {
  _id: new ObjectId(),
  name: 'RentGear Demo Owner',
  email: 'owner@rentgear.demo',
  role: 'owner',
  photoURL: '',
  phone: '+880 1700-000000',
  address: 'Dhaka, Bangladesh',
  createdAt: new Date(),
};

const equipment = [
  ['Excavator CAT 320', 'Construction Equipment', 'Dhaka', 48000, 'Daily', 3, 'Excellent', 'Caterpillar', '320D'],
  ['Sony A7 III Camera Kit', 'Photography Equipment', 'Dhaka', 6500, 'Daily', 8, 'Excellent', 'Sony', 'A7 III'],
  ['Toyota HiAce Van', 'Vehicles & Transportation', 'Chattogram', 12000, 'Daily', 4, 'Very Good', 'Toyota', 'HiAce'],
  ['Tractor - 4WD', 'Agriculture Equipment', 'Cumilla', 9500, 'Daily', 5, 'Good', 'Ford', '6610'],
  ['MacBook Pro 16"', 'Electronics', 'Dhaka', 4500, 'Daily', 6, 'Excellent', 'Apple', 'MacBook Pro'],
  ['Wedding Stage & Lighting', 'Event Equipment', 'Dhaka', 25000, 'Daily', 2, 'Very Good', 'EventPro', 'Deluxe'],
].map(([name, category, location, price, rentalType, quantity, condition, brand, model], index) => ({
  _id: new ObjectId(),
  name, category, location, price, rentalType, quantity, condition, brand, model,
  description: `${name} available for rent in ${location}. Well-maintained, fully checked before every handover and ready for your project.`,
  image: [
    'https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=1200&q=80',
    'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=1200&q=80',
    'https://images.unsplash.com/photo-1449965408869-eaa3f722e40d?w=1200&q=80',
    'https://images.unsplash.com/photo-1500937386664-56d1dfef3854?w=1200&q=80',
    'https://images.unsplash.com/photo-1498049794561-7780e7231661?w=1200&q=80',
    'https://images.unsplash.com/photo-1519671282429-b44660aded63?w=1200&q=80',
  ][index],
  rentalTerms: 'Security deposit required. Late returns are charged one extra rental unit. The renter is responsible for fuel and transport.',
  status: 'approved',
  ownerId: owner._id,
  ownerName: owner.name,
  ownerEmail: owner.email,
  ownerPhoto: '',
  createdAt: new Date(Date.now() - index * 86_400_000),
}));

const reviews = [
  ['Rahim Ahmed', 5, 'The excavator arrived on time and in excellent condition. The owner was very cooperative throughout the rental.'],
  ['Sadia Islam', 5, 'Booking and payment were smooth. The camera kit was exactly as described and perfect for our shoot.'],
  ['Tanvir Hasan', 4, 'Great pricing and flexible rental period. Pickup was easy and the van was clean and well maintained.'],
  ['Nusrat Jahan', 5, 'Very professional service. The lighting setup made our event look amazing. Highly recommend RentGear.'],
  ['Imran Khan', 4, 'Good experience overall. The tractor worked perfectly for our harvest season and the delivery was on schedule.'],
].map(([userName, rating, comment], index) => ({
  userName, rating, comment,
  userId: new ObjectId(),
  equipmentName: equipment[index % equipment.length].name,
  equipmentId: equipment[index % equipment.length]._id,
  userPhoto: '',
  createdAt: new Date(Date.now() - index * 3 * 86_400_000),
}));

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);
  const [ownerCount, equipmentCount, reviewCount] = await Promise.all([
    db.collection('users').countDocuments({ email: owner.email }),
    db.collection('equipment').countDocuments({ status: 'approved' }),
    db.collection('reviews').countDocuments(),
  ]);

  if (!ownerCount) await db.collection('users').insertOne(owner);
  if (!equipmentCount) await db.collection('equipment').insertMany(equipment);
  if (!reviewCount) await db.collection('reviews').insertMany(reviews);

  console.log(`Seed complete — equipment: ${equipmentCount ? 'already present' : equipment.length}, reviews: ${reviewCount ? 'already present' : reviews.length}.`);
} finally {
  await client.close();
}
