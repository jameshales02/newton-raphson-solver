# -*- coding: utf-8 -*-
"""
Created on Mon Nov 10 12:07:01 2025

@author: 15hal
"""

import numpy as np
from newton_solve import newton_solve

# Example: Solve x^2 - 2 = 0 (the square root of 2)
def F(x):
    return [x[0]**2 - 2]

x0 = [1.0]  # starting guess
solution, info = newton_solve(F, x0)

print("Solution:", solution)
print("Info:", info)
