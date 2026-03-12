#!/usr/bin/env node

async function getCategory(planId, categoryId) {
  try {
    if (!process.env.YNAB_API_TOKEN) {
      throw new Error("YNAB_API_TOKEN environment variable is not set");
    }

    const response = await fetch(
      `https://api.ynab.com/v1/plans/${planId}/categories/${categoryId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.YNAB_API_TOKEN}`,
        },
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error.detail || "Failed to fetch category");
    }

    const data = await response.json();
    console.log("Category Details:");
    console.log(JSON.stringify(data.data.category, null, 2));

    return data.data.category;
  } catch (error) {
    console.error("Error fetching category:", error.message);
    process.exit(1);
  }
}

const args = process.argv.slice(2);

if (args.length !== 2) {
  console.error("Usage: node getCategory.js <planId> <categoryId>");
  process.exit(1);
}

const [planId, categoryId] = args;
getCategory(planId, categoryId);
