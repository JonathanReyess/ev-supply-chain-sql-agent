/**
 * Plotting Tool
 * Accepts SQL results and visualization parameters to generate a plot
 * Generates a physical PNG file using Chart.js and Node-Canvas.
 */

import { z } from 'zod';
// @ts-ignore - chart.js types may not be available
import { Chart, ChartConfiguration, registerables } from 'chart.js';
// @ts-ignore - canvas types may not be available
import { createCanvas } from 'canvas';
import * as fs from 'fs';
import * as path from 'path';

// Register necessary components for Chart.js to work in a Node environment
Chart.register(...registerables); 

// --- SCHEMA DEFINITIONS ---

const PlottingInputSchema = z.object({
  // The results of the successfully executed SQL query (provided by orchestrator, not LLM)
  query_results: z.array(z.record(z.any())).describe('The array of row objects returned by the SQL query executor.'),
  
  // Parameters the LLM must choose to define the plot
  title: z.string().describe('The main title of the visualization (e.g., "Average Delivery Time by Warehouse").'),
  x_axis_column: z.string().describe('The column from query_results to use for the X-axis (e.g., "warehouselocation").'),
  y_axis_column: z.string().describe('The column from query_results to use for the Y-axis (e.g., "average_order_to_delivery_time").'),
  plot_type: z.enum(['bar', 'line', 'scatter', 'table']).describe('The most appropriate visualization type for the data.'),
});

const PlottingOutputSchema = z.object({
  success: z.boolean(),
  plot_description: z.string().describe('A confirmation or description of the generated plot.'),
  plot_file_path: z.string().describe('The path to the generated PNG image file.'),
});

// --- CRITICAL ADDITION: CLEAN JSON SCHEMA FOR GEMINI API ---
// This excludes 'query_results' and provides the pure structure the LLM must generate.
export const PlottingInputJSONSchema = {
    type: "OBJECT",
    description: "Parameters required to visualize successful SQL query results.",
    properties: {
        title: { type: "STRING", description: 'The main title of the visualization (e.g., "Average Delivery Time by Warehouse").' },
        x_axis_column: { type: "STRING", description: 'The column from query_results to use for the X-axis (e.g., "warehouselocation").' },
        y_axis_column: { type: "STRING", description: 'The column from query_results to use for the Y-axis (e.g., "average_order_to_delivery_time").' },
        plot_type: { 
            type: "STRING", 
            enum: ['bar', 'line', 'scatter', 'table'],
            description: 'The most appropriate visualization type for the data.'
        },
    },
    // The required fields the LLM MUST generate
    required: ["title", "x_axis_column", "y_axis_column", "plot_type"]
};
// -----------------------------------------------------------

export type PlottingInput = z.infer<typeof PlottingInputSchema>;
export type PlottingOutput = z.infer<typeof PlottingOutputSchema>;

/**
 * Executes the Chart.js rendering and saves the plot as a PNG file.
 */
export async function generatePlot(input: PlottingInput): Promise<PlottingOutput> {
  const { query_results, title, x_axis_column, y_axis_column, plot_type } = input;
  
  if (!query_results || query_results.length === 0) {
    return {
      success: false,
      plot_description: 'Cannot generate plot: No data was provided.',
      plot_file_path: '',
    };
  }
  
  // --- Data Preparation ---
  const labels = query_results.map(row => String(row[x_axis_column]));
  // Convert BigInts/Strings to numbers for Chart.js, using parseFloat
  const dataPoints = query_results.map(row => parseFloat(String(row[y_axis_column])));
  
  // --- Chart Configuration ---
  const chartType = plot_type === 'table' ? 'bar' : plot_type; // Use bar as default/fallback for table
  const config: ChartConfiguration = {
    type: chartType as 'bar' | 'line' | 'scatter',
    data: {
      labels: labels,
      datasets: [{
        label: title.replace(' by Warehouse', ''), // Clean up label
        data: dataPoints,
        backgroundColor: 'rgba(75, 192, 192, 0.6)',
        borderColor: 'rgba(75, 192, 192, 1)',
        borderWidth: 1
      }]
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      scales: {
        y: {
          title: {
            display: true,
            text: y_axis_column
          }
        }
      },
      plugins: {
        title: {
          display: true,
          text: title
        },
        legend: {
          display: true
        }
      }
    }
  };

  // --- Rendering and File Saving ---
  const WIDTH = 800;
  const HEIGHT = 600;
  const canvas = createCanvas(WIDTH, HEIGHT);
  
  // Instantiate chart, forcing the context type for Chart.js
  const chart = new Chart(canvas as any, config);

  // Define output directory and file path
  const PLOT_DIR = path.join(process.cwd(), 'plots');
  if (!fs.existsSync(PLOT_DIR)) {
    fs.mkdirSync(PLOT_DIR);
  }
  const cleanTitle = title.replace(/[^\w\s]/gi, '').replace(/\s+/g, '_');
  const plotFilePath = path.join(PLOT_DIR, `${cleanTitle}_${Date.now()}.png`);

  // Save the image buffer to disk
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(plotFilePath);
    const stream = canvas.createPNGStream();

    stream.pipe(out);
    out.on('finish', () => {
      resolve({
        success: true,
        plot_description: `Successfully rendered and saved a ${chartType} chart titled "${title}"`,
        plot_file_path: path.relative(process.cwd(), plotFilePath), // Return relative path
      });
    });
    out.on('error', reject);
  });
}

/**
 * Plotting Tool Definition for Gemini Agent SDK
 */
export const plottingTool = {
  name: 'generate_plot',
  description: 'Visualize structured query results by generating a chart (bar, line, scatter) or a formatted table. Saves plot as a PNG file in the /plots directory.',
  input_schema: PlottingInputSchema,
  execute: async (input: PlottingInput): Promise<PlottingOutput> => {
    return generatePlot(input);
  },
};