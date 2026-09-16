/** Create a room. Usage: npm run seed -- "objective" "icp description" */
const [objective = 'Book 5 discovery calls with engineering leaders at AI infra startups',
       icp = 'VP of Engineering or CTO at US-based B2B software companies with 20-500 employees']
  = process.argv.slice(2);

const res = await fetch(`http://localhost:${process.env.PORT || 3000}/api/rooms`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ objective, icp, members: ['alice', 'bob'] }),
});
const room = await res.json();
if (!res.ok) { console.error(room); process.exit(1); }
const base = `http://localhost:${process.env.PORT || 3000}/?room=${room.id}`;
console.log(`room ${room.id}\n  alice: ${base}&user=alice\n  bob:   ${base}&user=bob`);
