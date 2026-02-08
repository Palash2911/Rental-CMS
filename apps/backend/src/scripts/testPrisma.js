import prisma from "../prisma.js";

const run = async () => {
  const users = await prisma.user.findMany();
  console.log(users);
};

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
